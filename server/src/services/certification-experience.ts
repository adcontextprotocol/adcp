import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('certification-experience');

export type CertificationExperienceEventType =
  | 'chat_turn_started'
  | 'chat_turn_completed'
  | 'chat_turn_interrupted'
  | 'chat_turn_retry_requested'
  | 'completion_reserve_used'
  | 'capacity_blocked'
  | 'module_resumed'
  | 'module_evidence_complete'
  | 'module_completed'
  | 'credential_processing'
  | 'credential_action_required'
  | 'credential_issued'
  | 'contribution_drafted'
  | 'contribution_submitted';

export interface CertificationModuleExperience {
  module_id: string;
  title: string;
  status: 'not_started' | 'in_progress' | 'evidence_complete' | 'completed';
  resume_conversation_id: string | null;
  checkpoint: {
    saved_at: string;
    current_phase: string;
    concepts_covered: string[];
    concepts_remaining: string[];
    demonstrations_verified: string[];
    required_demonstrations: number;
  } | null;
  credential: {
    state: 'not_earned' | 'action_required' | 'processing' | 'issued';
    action: 'provide_name' | 'contact_support' | null;
    name: string | null;
    url: string | null;
  };
}

export interface CertificationContribution {
  id: string;
  module_id: string | null;
  repository: string;
  title: string;
  status: 'drafted' | 'submitted';
  draft_url: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  created_at: string;
  updated_at: string;
}

function criterionIds(exerciseDefinitions: unknown): string[] {
  if (!Array.isArray(exerciseDefinitions)) return [];
  const ids: string[] = [];
  for (const exercise of exerciseDefinitions) {
    if (!exercise || typeof exercise !== 'object') continue;
    const criteria = (exercise as { success_criteria?: unknown }).success_criteria;
    if (!Array.isArray(criteria)) continue;
    for (const criterion of criteria) {
      if (criterion && typeof criterion === 'object' && typeof (criterion as { id?: unknown }).id === 'string') {
        ids.push((criterion as { id: string }).id);
      }
    }
  }
  return ids;
}

/** Analytics must never block the learner path. */
export async function recordCertificationExperienceEvent(input: {
  userId: string;
  moduleId?: string | null;
  threadId?: string | null;
  eventType: CertificationExperienceEventType;
  clientRequestId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO certification_experience_events
         (workos_user_id, module_id, addie_thread_id, event_type, client_request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        input.userId,
        input.moduleId ?? null,
        input.threadId ?? null,
        input.eventType,
        input.clientRequestId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (error) {
    logger.error({ error, eventType: input.eventType }, 'Failed to record certification experience event');
  }
}

export async function linkCertificationModuleThread(
  userId: string,
  moduleId: string,
  threadId: string | undefined,
): Promise<void> {
  if (!threadId) return;
  await query(
    `UPDATE learner_progress
     SET addie_thread_id = $3, updated_at = NOW()
     WHERE workos_user_id = $1 AND module_id = $2 AND status = 'in_progress'`,
    [userId, moduleId, threadId],
  );
}

export async function getCertificationModuleExperience(
  userId: string,
  moduleId: string,
): Promise<CertificationModuleExperience | null> {
  const result = await query<{
    module_id: string;
    title: string;
    progress_status: 'in_progress' | 'completed' | 'tested_out' | null;
    exercise_definitions: unknown;
    addie_thread_id: string | null;
    resume_conversation_id: string | null;
    checkpoint_saved_at: string | null;
    current_phase: string | null;
    concepts_covered: string[] | null;
    concepts_remaining: string[] | null;
    demonstrations_verified: string[] | null;
    preliminary_scores: Record<string, number> | null;
  }>(
    `SELECT m.id AS module_id, m.title, lp.status AS progress_status,
            m.exercise_definitions, lp.addie_thread_id,
            COALESCE(t.external_id, lp.addie_thread_id) AS resume_conversation_id,
            tc.created_at::text AS checkpoint_saved_at, tc.current_phase,
            tc.concepts_covered, tc.concepts_remaining,
            tc.demonstrations_verified, tc.preliminary_scores
     FROM certification_modules m
     LEFT JOIN learner_progress lp
       ON lp.module_id = m.id AND lp.workos_user_id = $1
     LEFT JOIN LATERAL (
       SELECT * FROM teaching_checkpoints
       WHERE workos_user_id = $1 AND module_id = m.id
       ORDER BY created_at DESC LIMIT 1
     ) tc ON TRUE
     LEFT JOIN addie_threads t
       ON t.thread_id::text = lp.addie_thread_id OR t.external_id = lp.addie_thread_id
     WHERE m.id = $2`,
    [userId, moduleId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const requiredIds = criterionIds(row.exercise_definitions);
  const verified = row.demonstrations_verified ?? [];
  const evidenceComplete = requiredIds.every(id => verified.includes(id)) && !!row.preliminary_scores;
  let status: CertificationModuleExperience['status'] = 'not_started';
  if (row.progress_status === 'completed' || row.progress_status === 'tested_out') status = 'completed';
  else if (row.progress_status === 'in_progress' && evidenceComplete) status = 'evidence_complete';
  else if (row.progress_status === 'in_progress') status = 'in_progress';

  const credentialResult = await query<{
    name: string;
    all_requirements_met: boolean;
    user_credential_id: string | null;
    certifier_group_id: string | null;
    certifier_credential_id: string | null;
    certifier_public_id: string | null;
    certifier_issuance_state: string | null;
    has_credential_name: boolean;
  }>(
    `SELECT cc.name,
            NOT EXISTS (
              SELECT 1 FROM unnest(cc.required_modules) required_module
              WHERE NOT EXISTS (
                SELECT 1 FROM learner_progress completed
                WHERE completed.workos_user_id = $1
                  AND completed.module_id = required_module
                  AND completed.status IN ('completed', 'tested_out')
              )
            ) AS all_requirements_met,
            uc.id AS user_credential_id, cc.certifier_group_id,
            uc.certifier_credential_id, uc.certifier_public_id,
            uc.certifier_issuance_state,
            NULLIF(TRIM(COALESCE(u.first_name, '')), '') IS NOT NULL AS has_credential_name
     FROM certification_credentials cc
     LEFT JOIN user_credentials uc
       ON uc.credential_id = cc.id AND uc.workos_user_id = $1
     LEFT JOIN users u ON u.workos_user_id = $1
     WHERE $2 = ANY(cc.required_modules)
     ORDER BY cc.tier ASC
     LIMIT 1`,
    [userId, moduleId],
  );
  const credentialRow = credentialResult.rows[0];
  let credentialState: CertificationModuleExperience['credential']['state'] = 'not_earned';
  let credentialAction: CertificationModuleExperience['credential']['action'] = null;
  let credentialUrl: string | null = null;
  if (credentialRow?.all_requirements_met) {
    const issued = Boolean(credentialRow.user_credential_id) && (
      credentialRow.certifier_group_id === null
      || Boolean(credentialRow.certifier_credential_id && credentialRow.certifier_public_id)
    );
    const processing = ['creating', 'draft_created', 'issuing'].includes(
      credentialRow.certifier_issuance_state ?? '',
    );
    credentialState = issued ? 'issued' : processing ? 'processing' : 'action_required';
    if (credentialState === 'action_required') {
      credentialAction = credentialRow.certifier_group_id !== null && !credentialRow.has_credential_name
        ? 'provide_name'
        : 'contact_support';
    }
    if (credentialRow.certifier_public_id) {
      credentialUrl = `https://credsverse.com/credentials/${credentialRow.certifier_public_id}`;
    }
  }

  return {
    module_id: row.module_id,
    title: row.title,
    status,
    resume_conversation_id: row.resume_conversation_id,
    checkpoint: row.checkpoint_saved_at ? {
      saved_at: row.checkpoint_saved_at,
      current_phase: row.current_phase ?? 'teaching',
      concepts_covered: row.concepts_covered ?? [],
      concepts_remaining: row.concepts_remaining ?? [],
      demonstrations_verified: verified,
      required_demonstrations: requiredIds.length,
    } : null,
    credential: {
      state: credentialState,
      action: credentialAction,
      name: credentialRow?.name ?? null,
      url: credentialUrl,
    },
  };
}

export async function getCertificationExperienceForClientRequest(
  userId: string,
  clientRequestId: string,
): Promise<CertificationModuleExperience | null> {
  const result = await query<{ module_id: string }>(
    `SELECT module_id
     FROM certification_experience_events
     WHERE workos_user_id = $1 AND client_request_id = $2 AND module_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, clientRequestId],
  );
  const moduleId = result.rows[0]?.module_id;
  return moduleId ? getCertificationModuleExperience(userId, moduleId) : null;
}

export async function upsertCertificationContribution(input: {
  userId: string;
  moduleId?: string | null;
  repository: string;
  title: string;
  status: 'drafted' | 'submitted';
  draftUrl?: string | null;
  issueNumber?: number | null;
  issueUrl?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO certification_contributions
       (workos_user_id, module_id, repository, title, status, draft_url,
        github_issue_number, github_issue_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workos_user_id, repository, title) DO UPDATE SET
       module_id = COALESCE(EXCLUDED.module_id, certification_contributions.module_id),
       status = CASE WHEN EXCLUDED.status = 'submitted' THEN 'submitted'
                     ELSE certification_contributions.status END,
       draft_url = COALESCE(EXCLUDED.draft_url, certification_contributions.draft_url),
       github_issue_number = COALESCE(EXCLUDED.github_issue_number, certification_contributions.github_issue_number),
       github_issue_url = COALESCE(EXCLUDED.github_issue_url, certification_contributions.github_issue_url),
       updated_at = NOW()`,
    [
      input.userId, input.moduleId ?? null, input.repository, input.title, input.status,
      input.draftUrl ?? null, input.issueNumber ?? null, input.issueUrl ?? null,
    ],
  );
}

export async function getCertificationContributions(userId: string): Promise<CertificationContribution[]> {
  const result = await query<CertificationContribution>(
    `SELECT id, module_id, repository, title, status, draft_url,
            github_issue_number, github_issue_url, created_at::text, updated_at::text
     FROM certification_contributions
     WHERE workos_user_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [userId],
  );
  return result.rows;
}

export async function confirmCertificationContribution(
  userId: string,
  contributionId: string,
  issueUrl: string,
): Promise<CertificationContribution | null> {
  const existing = await query<CertificationContribution>(
    `SELECT * FROM certification_contributions WHERE id = $1 AND workos_user_id = $2`,
    [contributionId, userId],
  );
  const contribution = existing.rows[0];
  if (!contribution) return null;

  let parsed: URL;
  try {
    parsed = new URL(issueUrl);
  } catch {
    throw new Error('Enter the full GitHub issue URL.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const issueNumber = Number(parts[3]);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
      || parts[2] !== 'issues' || !Number.isSafeInteger(issueNumber) || issueNumber < 1
      || `${parts[0]}/${parts[1]}` !== contribution.repository) {
    throw new Error(`Enter an issue URL from ${contribution.repository}.`);
  }

  const response = await fetch(
    `https://api.github.com/repos/${contribution.repository}/issues/${issueNumber}`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'adcp-certification' } },
  );
  if (!response.ok) throw new Error('That GitHub issue could not be verified.');
  const issue = await response.json() as {
    title?: string;
    html_url?: string;
    pull_request?: unknown;
  };
  if (issue.pull_request || issue.title?.trim() !== contribution.title.trim()
      || issue.html_url !== parsed.href.replace(/\/$/, '')) {
    throw new Error('The issue repository and title must match the saved contribution draft.');
  }

  const updated = await query<CertificationContribution>(
    `UPDATE certification_contributions
     SET status = 'submitted', github_issue_number = $3,
         github_issue_url = $4, updated_at = NOW()
     WHERE id = $1 AND workos_user_id = $2
     RETURNING *`,
    [contributionId, userId, issueNumber, issue.html_url],
  );
  await recordCertificationExperienceEvent({
    userId,
    moduleId: contribution.module_id,
    eventType: 'contribution_submitted',
    metadata: { repository: contribution.repository, title: contribution.title, issue_number: issueNumber },
  });
  return updated.rows[0] ?? null;
}

export async function getCertificationExperienceMetrics(): Promise<{
  window_days: number;
  turns_started: number;
  turns_completed: number;
  turns_interrupted: number;
  retries_requested: number;
  recovered_turns: number;
  recovery_rate: number;
  capacity_blocks: number;
  reserve_turns: number;
  resume_sessions: number;
  resume_completion_rate: number;
  evidence_completion_rate: number;
  credential_actions_required: number;
  credential_action_resolution_rate: number;
  contributions_drafted: number;
  contributions_submitted: number;
  completion_rate: number;
  interruption_rate: number;
  contribution_submit_rate: number;
  avg_credential_latency_seconds: number | null;
  model_outcomes: Array<{
    model: string;
    module_id: string | null;
    turns_started: number;
    turns_completed: number;
    turns_interrupted: number;
    evidence_complete: number;
    modules_completed: number;
    credentials_issued: number;
  }>;
}> {
  const result = await query<Record<string, string | null>>(
    `WITH event_metrics AS (
       SELECT
         COUNT(*) FILTER (WHERE event.event_type = 'chat_turn_started') AS turns_started,
         COUNT(*) FILTER (WHERE event.event_type = 'chat_turn_completed') AS turns_completed,
         COUNT(*) FILTER (WHERE event.event_type = 'chat_turn_interrupted') AS turns_interrupted,
         COUNT(*) FILTER (WHERE event.event_type = 'chat_turn_retry_requested') AS retries_requested,
         COUNT(*) FILTER (WHERE event.event_type = 'capacity_blocked') AS capacity_blocks,
         COUNT(*) FILTER (WHERE event.event_type = 'completion_reserve_used') AS reserve_turns,
         COUNT(*) FILTER (WHERE event.event_type = 'module_resumed') AS resume_sessions,
         COUNT(*) FILTER (WHERE event.event_type = 'module_resumed' AND EXISTS (
           SELECT 1 FROM certification_experience_events completed
           WHERE completed.workos_user_id = event.workos_user_id
             AND completed.module_id = event.module_id
             AND completed.event_type = 'module_completed'
             AND completed.created_at >= event.created_at
         )) AS resume_completions,
         COUNT(*) FILTER (WHERE event.event_type = 'module_evidence_complete') AS evidence_checkpoints,
         COUNT(*) FILTER (WHERE event.event_type = 'module_evidence_complete' AND EXISTS (
           SELECT 1 FROM certification_experience_events completed
           WHERE completed.workos_user_id = event.workos_user_id
             AND completed.module_id = event.module_id
             AND completed.event_type = 'module_completed'
             AND completed.created_at >= event.created_at
         )) AS evidence_completions,
         COUNT(*) FILTER (WHERE event.event_type = 'credential_action_required') AS credential_actions_required,
         COUNT(*) FILTER (WHERE event.event_type = 'credential_action_required' AND EXISTS (
           SELECT 1 FROM certification_experience_events issued
           WHERE issued.workos_user_id = event.workos_user_id
             AND issued.module_id = event.module_id
             AND issued.event_type = 'credential_issued'
             AND issued.created_at >= event.created_at
         )) AS credential_actions_resolved
       FROM certification_experience_events event
       WHERE event.created_at > NOW() - INTERVAL '30 days'
     ), recovery_metrics AS (
       SELECT COUNT(DISTINCT retry.client_request_id) AS recovered_turns
       FROM certification_experience_events retry
       WHERE retry.event_type = 'chat_turn_retry_requested'
         AND retry.client_request_id IS NOT NULL
         AND retry.created_at > NOW() - INTERVAL '30 days'
         AND EXISTS (
           SELECT 1 FROM certification_experience_events completed
           WHERE completed.workos_user_id = retry.workos_user_id
             AND completed.client_request_id = retry.client_request_id
             AND completed.event_type = 'chat_turn_completed'
         )
     ), contribution_metrics AS (
       SELECT COUNT(*) AS contributions_drafted,
              COUNT(*) FILTER (WHERE status = 'submitted') AS contributions_submitted
       FROM certification_contributions
       WHERE created_at > NOW() - INTERVAL '30 days'
     ), credential_metrics AS (
       SELECT ROUND(AVG(EXTRACT(EPOCH FROM (certifier_issued_at - awarded_at))))
                AS avg_credential_latency_seconds
       FROM user_credentials
       WHERE certifier_issued_at > NOW() - INTERVAL '30 days'
     )
     SELECT e.turns_started::text, e.turns_completed::text,
            e.turns_interrupted::text, e.retries_requested::text,
            r.recovered_turns::text, e.capacity_blocks::text,
            e.reserve_turns::text, e.resume_sessions::text,
            e.resume_completions::text, e.evidence_checkpoints::text,
            e.evidence_completions::text, e.credential_actions_required::text,
            e.credential_actions_resolved::text,
            c.contributions_drafted::text, c.contributions_submitted::text,
            g.avg_credential_latency_seconds::text
     FROM event_metrics e CROSS JOIN recovery_metrics r
       CROSS JOIN contribution_metrics c CROSS JOIN credential_metrics g`,
  );
  const row = result.rows[0] ?? {};
  const number = (key: string) => Number(row[key] ?? 0);
  const started = number('turns_started');
  const interrupted = number('turns_interrupted');
  const drafted = number('contributions_drafted');
  const completed = number('turns_completed');
  const submitted = number('contributions_submitted');
  const retries = number('retries_requested');
  const recovered = number('recovered_turns');
  const resumes = number('resume_sessions');
  const evidence = number('evidence_checkpoints');
  const credentialActions = number('credential_actions_required');
  const modelResult = await query<{
    model: string;
    module_id: string | null;
    turns_started: string;
    turns_completed: string;
    turns_interrupted: string;
    evidence_complete: string;
    modules_completed: string;
    credentials_issued: string;
  }>(
    `SELECT metadata->>'model' AS model, module_id,
            COUNT(*) FILTER (WHERE event_type = 'chat_turn_started')::text AS turns_started,
            COUNT(*) FILTER (WHERE event_type = 'chat_turn_completed')::text AS turns_completed,
            COUNT(*) FILTER (WHERE event_type = 'chat_turn_interrupted')::text AS turns_interrupted,
            COUNT(*) FILTER (WHERE event_type = 'module_evidence_complete')::text AS evidence_complete,
            COUNT(*) FILTER (WHERE event_type = 'module_completed')::text AS modules_completed,
            COUNT(*) FILTER (WHERE event_type = 'credential_issued')::text AS credentials_issued
     FROM certification_experience_events
     WHERE created_at > NOW() - INTERVAL '30 days'
       AND metadata ? 'model'
     GROUP BY metadata->>'model', module_id
     ORDER BY COUNT(*) DESC`,
  );
  return {
    window_days: 30,
    turns_started: started,
    turns_completed: completed,
    turns_interrupted: interrupted,
    retries_requested: retries,
    recovered_turns: recovered,
    recovery_rate: retries > 0 ? Math.round((recovered / retries) * 1000) / 10 : 0,
    capacity_blocks: number('capacity_blocks'),
    reserve_turns: number('reserve_turns'),
    resume_sessions: resumes,
    resume_completion_rate: resumes > 0
      ? Math.round((number('resume_completions') / resumes) * 1000) / 10 : 0,
    evidence_completion_rate: evidence > 0
      ? Math.round((number('evidence_completions') / evidence) * 1000) / 10 : 0,
    credential_actions_required: credentialActions,
    credential_action_resolution_rate: credentialActions > 0
      ? Math.round((number('credential_actions_resolved') / credentialActions) * 1000) / 10 : 0,
    contributions_drafted: drafted,
    contributions_submitted: submitted,
    completion_rate: started > 0 ? Math.round((completed / started) * 1000) / 10 : 0,
    interruption_rate: started > 0 ? Math.round((interrupted / started) * 1000) / 10 : 0,
    contribution_submit_rate: drafted > 0 ? Math.round((submitted / drafted) * 1000) / 10 : 0,
    avg_credential_latency_seconds: row.avg_credential_latency_seconds === null
      ? null
      : Number(row.avg_credential_latency_seconds),
    model_outcomes: modelResult.rows.map(outcome => ({
      model: outcome.model,
      module_id: outcome.module_id,
      turns_started: Number(outcome.turns_started),
      turns_completed: Number(outcome.turns_completed),
      turns_interrupted: Number(outcome.turns_interrupted),
      evidence_complete: Number(outcome.evidence_complete),
      modules_completed: Number(outcome.modules_completed),
      credentials_issued: Number(outcome.credentials_issued),
    })),
  };
}

import { query } from './client.js';
import type {
  OutreachGoal,
  GoalOutcome,
  UserGoalHistory,
  RehearsalSession,
  RehearsalMessage,
  RehearsalPersona,
  CreateGoalInput,
  CreateOutcomeInput,
  GoalCategory,
  GoalStatus,
  OutcomeTriggerType,
  OutcomeType,
  PlannerDecisionMethod,
  RehearsalStatus,
  MemberCapabilities,
} from '../addie/types.js';

// =====================================================
// OUTREACH GOALS
// =====================================================

/**
 * List all outreach goals
 */
export async function listGoals(options?: {
  enabledOnly?: boolean;
  category?: GoalCategory;
}): Promise<OutreachGoal[]> {
  let sql = `
    SELECT
      id, name, category, description, success_insight_type,
      requires_mapped, requires_company_type, requires_min_engagement,
      requires_insights, excludes_insights, base_priority,
      message_template, follow_up_on_question, is_enabled,
      created_by, created_at, updated_at
    FROM outreach_goals
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (options?.enabledOnly) {
    sql += ` AND is_enabled = TRUE`;
  }

  if (options?.category) {
    params.push(options.category);
    sql += ` AND category = $${params.length}`;
  }

  sql += ` ORDER BY base_priority DESC, name ASC`;

  const result = await query(sql, params);
  return result.rows.map(rowToGoal);
}

/**
 * Get a single goal by ID
 */
export async function getGoal(id: number): Promise<OutreachGoal | null> {
  const result = await query(
    `SELECT * FROM outreach_goals WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? rowToGoal(result.rows[0]) : null;
}

/**
 * Create a new goal
 */
export async function createGoal(input: CreateGoalInput): Promise<OutreachGoal> {
  const result = await query(
    `INSERT INTO outreach_goals (
      name, category, description, success_insight_type,
      requires_mapped, requires_company_type, requires_min_engagement,
      requires_insights, excludes_insights, base_priority,
      message_template, follow_up_on_question, is_enabled, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      input.name,
      input.category,
      input.description ?? null,
      input.success_insight_type ?? null,
      input.requires_mapped ?? false,
      input.requires_company_type ?? [],
      input.requires_min_engagement ?? 0,
      JSON.stringify(input.requires_insights ?? {}),
      JSON.stringify(input.excludes_insights ?? {}),
      input.base_priority ?? 50,
      input.message_template,
      input.follow_up_on_question ?? null,
      input.is_enabled ?? true,
      input.created_by ?? null,
    ]
  );
  return rowToGoal(result.rows[0]);
}

/**
 * Update a goal
 */
export async function updateGoal(
  id: number,
  updates: Partial<CreateGoalInput>
): Promise<OutreachGoal | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const fieldMap: Record<string, string> = {
    name: 'name',
    category: 'category',
    description: 'description',
    success_insight_type: 'success_insight_type',
    requires_mapped: 'requires_mapped',
    requires_company_type: 'requires_company_type',
    requires_min_engagement: 'requires_min_engagement',
    requires_insights: 'requires_insights',
    excludes_insights: 'excludes_insights',
    base_priority: 'base_priority',
    message_template: 'message_template',
    follow_up_on_question: 'follow_up_on_question',
    is_enabled: 'is_enabled',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    if (key in updates) {
      let value = updates[key as keyof CreateGoalInput];
      // JSON fields need to be stringified
      if (key === 'requires_insights' || key === 'excludes_insights') {
        value = JSON.stringify(value ?? {});
      }
      fields.push(`${column} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (fields.length === 0) return getGoal(id);

  values.push(id);
  const result = await query(
    `UPDATE outreach_goals SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] ? rowToGoal(result.rows[0]) : null;
}

/**
 * Delete a goal
 */
export async function deleteGoal(id: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM outreach_goals WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// =====================================================
// GOAL OUTCOMES
// =====================================================

/**
 * List outcomes for a goal
 */
export async function listOutcomes(goalId: number): Promise<GoalOutcome[]> {
  const result = await query(
    `SELECT * FROM goal_outcomes WHERE goal_id = $1 ORDER BY priority DESC`,
    [goalId]
  );
  return result.rows.map(rowToOutcome);
}

/**
 * Get outcomes for multiple goals
 */
export async function getOutcomesForGoals(goalIds: number[]): Promise<Map<number, GoalOutcome[]>> {
  if (goalIds.length === 0) return new Map();

  const result = await query(
    `SELECT * FROM goal_outcomes WHERE goal_id = ANY($1) ORDER BY goal_id, priority DESC`,
    [goalIds]
  );

  const map = new Map<number, GoalOutcome[]>();
  for (const row of result.rows) {
    const outcome = rowToOutcome(row);
    const existing = map.get(outcome.goal_id) ?? [];
    existing.push(outcome);
    map.set(outcome.goal_id, existing);
  }
  return map;
}

/**
 * Create an outcome
 */
export async function createOutcome(input: CreateOutcomeInput): Promise<GoalOutcome> {
  const result = await query(
    `INSERT INTO goal_outcomes (
      goal_id, trigger_type, trigger_value, outcome_type,
      response_message, next_goal_id, defer_days,
      insight_to_record, insight_value, priority
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      input.goal_id,
      input.trigger_type,
      input.trigger_value ?? null,
      input.outcome_type,
      input.response_message ?? null,
      input.next_goal_id ?? null,
      input.defer_days ?? null,
      input.insight_to_record ?? null,
      input.insight_value ?? null,
      input.priority ?? 50,
    ]
  );
  return rowToOutcome(result.rows[0]);
}

/**
 * Update an outcome
 */
export async function updateOutcome(
  id: number,
  updates: Partial<CreateOutcomeInput>
): Promise<GoalOutcome | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const allowedFields = [
    'trigger_type', 'trigger_value', 'outcome_type',
    'response_message', 'next_goal_id', 'defer_days',
    'insight_to_record', 'insight_value', 'priority'
  ];

  for (const field of allowedFields) {
    if (field in updates) {
      fields.push(`${field} = $${paramIndex}`);
      values.push(updates[field as keyof CreateOutcomeInput]);
      paramIndex++;
    }
  }

  if (fields.length === 0) {
    const result = await query(`SELECT * FROM goal_outcomes WHERE id = $1`, [id]);
    return result.rows[0] ? rowToOutcome(result.rows[0]) : null;
  }

  values.push(id);
  const result = await query(
    `UPDATE goal_outcomes SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] ? rowToOutcome(result.rows[0]) : null;
}

/**
 * Delete an outcome
 */
export async function deleteOutcome(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM goal_outcomes WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// =====================================================
// USER GOAL HISTORY
// =====================================================

/**
 * Get goal history for a user
 */
export async function getUserGoalHistory(
  slackUserId: string,
  options?: {
    status?: GoalStatus[];
    goalIds?: number[];
  }
): Promise<UserGoalHistory[]> {
  let sql = `SELECT * FROM user_goal_history WHERE slack_user_id = $1`;
  const params: unknown[] = [slackUserId];

  if (options?.status && options.status.length > 0) {
    params.push(options.status);
    sql += ` AND status = ANY($${params.length})`;
  }

  if (options?.goalIds && options.goalIds.length > 0) {
    params.push(options.goalIds);
    sql += ` AND goal_id = ANY($${params.length})`;
  }

  sql += ` ORDER BY updated_at DESC`;

  const result = await query(sql, params);
  return result.rows.map(rowToHistory);
}

/**
 * Record a new goal attempt
 */
export async function recordGoalAttempt(params: {
  slack_user_id: string;
  goal_id: number;
  planner_reason: string;
  planner_score: number;
  decision_method: PlannerDecisionMethod;
  outreach_id?: number;
  thread_id?: string;
}): Promise<UserGoalHistory> {
  // Check for existing history
  const existing = await query(
    `SELECT id, attempt_count FROM user_goal_history
     WHERE slack_user_id = $1 AND goal_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [params.slack_user_id, params.goal_id]
  );

  if (existing.rows[0]) {
    // Update existing record
    const result = await query(
      `UPDATE user_goal_history SET
        status = 'sent',
        attempt_count = attempt_count + 1,
        last_attempt_at = NOW(),
        planner_reason = $2,
        planner_score = $3,
        decision_method = $4,
        outreach_id = COALESCE($5, outreach_id),
        thread_id = COALESCE($6, thread_id)
      WHERE id = $1
      RETURNING *`,
      [
        existing.rows[0].id,
        params.planner_reason,
        params.planner_score,
        params.decision_method,
        params.outreach_id ?? null,
        params.thread_id ?? null,
      ]
    );
    return rowToHistory(result.rows[0]);
  }

  // Create new record
  const result = await query(
    `INSERT INTO user_goal_history (
      slack_user_id, goal_id, status, attempt_count, last_attempt_at,
      planner_reason, planner_score, decision_method, outreach_id, thread_id
    ) VALUES ($1, $2, 'sent', 1, NOW(), $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      params.slack_user_id,
      params.goal_id,
      params.planner_reason,
      params.planner_score,
      params.decision_method,
      params.outreach_id ?? null,
      params.thread_id ?? null,
    ]
  );
  return rowToHistory(result.rows[0]);
}

/**
 * Update goal history with response
 */
export async function updateGoalResponse(params: {
  history_id: number;
  status: GoalStatus;
  outcome_id?: number;
  response_text?: string;
  response_sentiment?: string;
  response_intent?: string;
  next_attempt_at?: Date;
}): Promise<UserGoalHistory | null> {
  const result = await query(
    `UPDATE user_goal_history SET
      status = $2,
      outcome_id = COALESCE($3, outcome_id),
      response_text = COALESCE($4, response_text),
      response_sentiment = COALESCE($5, response_sentiment),
      response_intent = COALESCE($6, response_intent),
      next_attempt_at = $7
    WHERE id = $1
    RETURNING *`,
    [
      params.history_id,
      params.status,
      params.outcome_id ?? null,
      params.response_text ?? null,
      params.response_sentiment ?? null,
      params.response_intent ?? null,
      params.next_attempt_at ?? null,
    ]
  );
  return result.rows[0] ? rowToHistory(result.rows[0]) : null;
}

/**
 * Get users ready for deferred goal retry
 */
export async function getUsersReadyForRetry(): Promise<UserGoalHistory[]> {
  const result = await query(
    `SELECT * FROM user_goal_history
     WHERE status = 'deferred'
       AND next_attempt_at IS NOT NULL
       AND next_attempt_at <= NOW()
     ORDER BY next_attempt_at ASC`
  );
  return result.rows.map(rowToHistory);
}

// =====================================================
// REHEARSAL SESSIONS
// =====================================================

/**
 * Create a rehearsal session
 */
export async function createRehearsalSession(params: {
  admin_user_id: string;
  persona_name?: string;
  persona_context: RehearsalPersona;
}): Promise<RehearsalSession> {
  const result = await query(
    `INSERT INTO rehearsal_sessions (
      admin_user_id, persona_name, persona_context, status, messages
    ) VALUES ($1, $2, $3, 'active', '[]')
    RETURNING *`,
    [
      params.admin_user_id,
      params.persona_name ?? null,
      JSON.stringify(params.persona_context),
    ]
  );
  return rowToSession(result.rows[0]);
}

/**
 * Get a rehearsal session
 */
export async function getRehearsalSession(id: number): Promise<RehearsalSession | null> {
  const result = await query(
    `SELECT * FROM rehearsal_sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? rowToSession(result.rows[0]) : null;
}

/**
 * List rehearsal sessions
 */
export async function listRehearsalSessions(options?: {
  admin_user_id?: string;
  status?: RehearsalStatus;
  limit?: number;
}): Promise<RehearsalSession[]> {
  let sql = `SELECT * FROM rehearsal_sessions WHERE 1=1`;
  const params: unknown[] = [];

  if (options?.admin_user_id) {
    params.push(options.admin_user_id);
    sql += ` AND admin_user_id = $${params.length}`;
  }

  if (options?.status) {
    params.push(options.status);
    sql += ` AND status = $${params.length}`;
  }

  sql += ` ORDER BY started_at DESC`;

  if (options?.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await query(sql, params);
  return result.rows.map(rowToSession);
}

/**
 * Add a message to a rehearsal session
 */
export async function addRehearsalMessage(
  sessionId: number,
  message: RehearsalMessage
): Promise<RehearsalSession | null> {
  const result = await query(
    `UPDATE rehearsal_sessions
     SET messages = messages || $2::jsonb,
         current_goal_id = COALESCE($3, current_goal_id)
     WHERE id = $1
     RETURNING *`,
    [
      sessionId,
      JSON.stringify([message]),
      message.goal_id ?? null,
    ]
  );
  return result.rows[0] ? rowToSession(result.rows[0]) : null;
}

/**
 * Complete a rehearsal session
 */
export async function completeRehearsalSession(
  sessionId: number,
  params: {
    notes?: string;
    outcome_summary?: string;
    status?: RehearsalStatus;
  }
): Promise<RehearsalSession | null> {
  const result = await query(
    `UPDATE rehearsal_sessions SET
      status = COALESCE($2, 'completed'),
      notes = COALESCE($3, notes),
      outcome_summary = COALESCE($4, outcome_summary),
      ended_at = NOW()
    WHERE id = $1
    RETURNING *`,
    [
      sessionId,
      params.status ?? 'completed',
      params.notes ?? null,
      params.outcome_summary ?? null,
    ]
  );
  return result.rows[0] ? rowToSession(result.rows[0]) : null;
}

// =====================================================
// GOAL SUMMARY VIEW
// =====================================================

export interface GoalSummary {
  id: number;
  name: string;
  category: GoalCategory;
  description: string | null;
  base_priority: number;
  is_enabled: boolean;
  outcome_count: number;
  total_attempts: number;
  successful_attempts: number;
  success_rate_pct: number | null;
}

/**
 * Get goal summaries with stats
 */
export async function getGoalSummaries(): Promise<GoalSummary[]> {
  const result = await query(`SELECT * FROM outreach_goals_summary ORDER BY base_priority DESC`);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    category: row.category as GoalCategory,
    description: row.description,
    base_priority: row.base_priority,
    is_enabled: row.is_enabled,
    outcome_count: parseInt(row.outcome_count, 10),
    total_attempts: parseInt(row.total_attempts, 10),
    successful_attempts: parseInt(row.successful_attempts, 10),
    success_rate_pct: row.success_rate_pct ? parseFloat(row.success_rate_pct) : null,
  }));
}

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function rowToGoal(row: Record<string, unknown>): OutreachGoal {
  return {
    id: row.id as number,
    name: row.name as string,
    category: row.category as GoalCategory,
    description: row.description as string | null,
    success_insight_type: row.success_insight_type as string | null,
    requires_mapped: row.requires_mapped as boolean,
    requires_company_type: row.requires_company_type as string[],
    requires_min_engagement: row.requires_min_engagement as number,
    requires_insights: (row.requires_insights ?? {}) as Record<string, string>,
    excludes_insights: (row.excludes_insights ?? {}) as Record<string, string>,
    base_priority: row.base_priority as number,
    message_template: row.message_template as string,
    follow_up_on_question: row.follow_up_on_question as string | null,
    is_enabled: row.is_enabled as boolean,
    created_by: row.created_by as string | null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function rowToOutcome(row: Record<string, unknown>): GoalOutcome {
  return {
    id: row.id as number,
    goal_id: row.goal_id as number,
    trigger_type: row.trigger_type as OutcomeTriggerType,
    trigger_value: row.trigger_value as string | null,
    outcome_type: row.outcome_type as OutcomeType,
    response_message: row.response_message as string | null,
    next_goal_id: row.next_goal_id as number | null,
    defer_days: row.defer_days as number | null,
    insight_to_record: row.insight_to_record as string | null,
    insight_value: row.insight_value as string | null,
    priority: row.priority as number,
    created_at: new Date(row.created_at as string),
  };
}

function rowToHistory(row: Record<string, unknown>): UserGoalHistory {
  return {
    id: row.id as number,
    slack_user_id: row.slack_user_id as string,
    goal_id: row.goal_id as number,
    status: row.status as GoalStatus,
    attempt_count: row.attempt_count as number,
    last_attempt_at: row.last_attempt_at ? new Date(row.last_attempt_at as string) : null,
    next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at as string) : null,
    outcome_id: row.outcome_id as number | null,
    response_text: row.response_text as string | null,
    response_sentiment: row.response_sentiment as string | null,
    response_intent: row.response_intent as string | null,
    planner_reason: row.planner_reason as string | null,
    planner_score: row.planner_score as number | null,
    decision_method: row.decision_method as PlannerDecisionMethod | null,
    outreach_id: row.outreach_id as number | null,
    thread_id: row.thread_id as string | null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function rowToSession(row: Record<string, unknown>): RehearsalSession {
  return {
    id: row.id as number,
    admin_user_id: row.admin_user_id as string,
    persona_name: row.persona_name as string | null,
    persona_context: (row.persona_context ?? {}) as RehearsalPersona,
    current_goal_id: row.current_goal_id as number | null,
    status: row.status as RehearsalStatus,
    messages: (row.messages ?? []) as RehearsalMessage[],
    notes: row.notes as string | null,
    outcome_summary: row.outcome_summary as string | null,
    started_at: new Date(row.started_at as string),
    ended_at: row.ended_at ? new Date(row.ended_at as string) : null,
    created_at: new Date(row.created_at as string),
  };
}


// =====================================================
// MEMBER CAPABILITIES
// =====================================================

/**
 * Get member capabilities - what features have they used/not used?
 * This helps the planner identify which capabilities to suggest.
 */
export async function getMemberCapabilities(
  slackUserId: string,
  workosUserId?: string
): Promise<MemberCapabilities> {
  // Default capabilities for unmapped users
  if (!workosUserId) {
    return {
      account_linked: false,
      profile_complete: false,
      offerings_set: false,
      email_prefs_configured: false,
      has_team_members: false,
      is_org_admin: false,
      working_group_count: 0,
      council_count: 0,
      events_registered: 0,
      events_attended: 0,
      last_active_days_ago: null,
      slack_message_count_30d: 0,
      is_committee_leader: false,
    };
  }

  // Query all capability states in parallel
  const [
    profileResult,
    teamResult,
    workingGroupResult,
    eventResult,
    activityResult,
    emailPrefsResult,
    leaderResult,
  ] = await Promise.all([
    // Profile completeness
    query<{
      has_profile: boolean;
      offerings_count: number;
    }>(
      `SELECT
        EXISTS(SELECT 1 FROM member_profiles mp
               JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
               WHERE om.workos_user_id = $1
               AND mp.display_name IS NOT NULL
               AND mp.description IS NOT NULL) as has_profile,
        COALESCE((SELECT array_length(mp.offerings, 1) FROM member_profiles mp
                  JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
                  WHERE om.workos_user_id = $1), 0) as offerings_count`,
      [workosUserId]
    ),

    // Team members
    query<{
      team_count: number;
      is_admin: boolean;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM organization_memberships om2
         WHERE om2.workos_organization_id = om.workos_organization_id
         AND om2.workos_user_id != $1) as team_count,
        EXISTS(SELECT 1 FROM organizations o
               JOIN organization_memberships om3 ON om3.workos_organization_id = o.workos_organization_id
               WHERE om3.workos_user_id = $1) as is_admin
       FROM organization_memberships om
       WHERE om.workos_user_id = $1
       LIMIT 1`,
      [workosUserId]
    ),

    // Working groups & councils
    query<{
      wg_count: number;
      council_count: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM working_group_memberships wgm
         JOIN working_groups wg ON wg.id = wgm.working_group_id
         WHERE wgm.workos_user_id = $1 AND wg.committee_type = 'working_group') as wg_count,
        (SELECT COUNT(*) FROM working_group_memberships wgm
         JOIN working_groups wg ON wg.id = wgm.working_group_id
         WHERE wgm.workos_user_id = $1 AND wg.committee_type = 'council') as council_count`,
      [workosUserId]
    ),

    // Events
    query<{
      registered: number;
      attended: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM event_registrations er WHERE er.workos_user_id = $1) as registered,
        (SELECT COUNT(*) FROM event_registrations er WHERE er.workos_user_id = $1 AND er.checked_in_at IS NOT NULL) as attended`,
      [workosUserId]
    ),

    // Recent activity
    query<{
      last_active_days: number | null;
      slack_messages_30d: number;
    }>(
      `SELECT
        EXTRACT(DAY FROM NOW() - COALESCE(
          (SELECT last_slack_activity_at FROM slack_user_mappings WHERE workos_user_id = $1),
          (SELECT created_at FROM slack_user_mappings WHERE workos_user_id = $1)
        )) as last_active_days,
        COALESCE((SELECT SUM(message_count) FROM slack_activity_daily
                  WHERE slack_user_id = (SELECT slack_user_id FROM slack_user_mappings WHERE workos_user_id = $1)
                  AND activity_date > NOW() - INTERVAL '30 days'), 0) as slack_messages_30d`,
      [workosUserId]
    ),

    // Email preferences
    query<{ configured: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM user_email_preferences WHERE workos_user_id = $1) as configured`,
      [workosUserId]
    ),

    // Leadership
    query<{ is_leader: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM working_group_leaders WHERE user_id = $1) as is_leader`,
      [workosUserId]
    ),
  ]);

  const profile = profileResult.rows[0] ?? { has_profile: false, offerings_count: 0 };
  const team = teamResult.rows[0] ?? { team_count: 0, is_admin: false };
  const wg = workingGroupResult.rows[0] ?? { wg_count: 0, council_count: 0 };
  const events = eventResult.rows[0] ?? { registered: 0, attended: 0 };
  const activity = activityResult.rows[0] ?? { last_active_days: null, slack_messages_30d: 0 };
  const emailPrefs = emailPrefsResult.rows[0] ?? { configured: false };
  const leader = leaderResult.rows[0] ?? { is_leader: false };

  return {
    account_linked: true,
    profile_complete: profile.has_profile,
    offerings_set: profile.offerings_count > 0,
    email_prefs_configured: emailPrefs.configured,
    has_team_members: Number(team.team_count) > 0,
    is_org_admin: team.is_admin,
    working_group_count: Number(wg.wg_count),
    council_count: Number(wg.council_count),
    events_registered: Number(events.registered),
    events_attended: Number(events.attended),
    last_active_days_ago: activity.last_active_days != null ? Number(activity.last_active_days) : null,
    slack_message_count_30d: Number(activity.slack_messages_30d),
    is_committee_leader: leader.is_leader,
  };
}

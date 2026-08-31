/**
 * Read-only impact report for the verification-profile shadow rollout.
 *
 * Dev:
 *   npx tsx server/src/scripts/audit-verification-profile-shadow.ts --hours=48
 * Production:
 *   fly ssh console -a adcp-docs -C \
 *     'node /app/dist/scripts/audit-verification-profile-shadow.js --hours=48'
 *
 * Add --include-agents only for a restricted operator review. The default
 * output is aggregate-only.
 */

import { pathToFileURL } from 'node:url';
import { closeDatabase, getPool, initializeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { VERIFICATION_PROFILE_SHADOW_POLICY_VERSION } from '../services/verification-profile-shadow.js';

export function parseHours(args: string[]): number {
  const raw = args.find((arg) => arg.startsWith('--hours='))?.slice('--hours='.length);
  if (raw === undefined) return 48;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 24 * 30) {
    throw new Error('--hours must be between 1 and 720');
  }
  return value;
}

export function calculateCoveragePercent(eligibleAgents: number, assessedEligibleAgents: number): number {
  if (eligibleAgents <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, assessedEligibleAgents) / eligibleAgents) * 10_000) / 100);
}

type Summary = Record<string, unknown>;

function numeric(summary: Summary, key: string): number {
  return Number(summary[key] ?? 0);
}

export function buildDecisionGates(summary: Summary): {
  automatic_gates_pass: boolean;
  blocking_reasons: string[];
  manual_review_reasons: string[];
  gates: Record<string, { pass: boolean; [key: string]: number | boolean }>;
} {
  const eligible = numeric(summary, 'eligible_agents');
  const assessed = numeric(summary, 'assessed_agents');
  const coverage = calculateCoveragePercent(eligible, assessed);
  const stableTwoRuns = numeric(summary, 'agents_with_stable_two_or_more_runs');
  const stableRepeatCoverage = calculateCoveragePercent(eligible, stableTwoRuns);
  const flapping = numeric(summary, 'flapping_agents');
  const incompleteRuns = numeric(summary, 'incomplete_latest_runs');
  const missingBundleEvidence = numeric(summary, 'latest_runs_missing_bundle_evidence');
  const sandboxUnresolvedBundles = numeric(summary, 'sandbox_unresolved_bundles');
  const unattributedFailures = numeric(summary, 'unattributed_failures');

  const gates = {
    coverage: { pass: eligible > 0 && coverage >= 95, actual_percent: coverage, minimum_percent: 95 },
    stable_repeat_observations: {
      pass: eligible > 0 && stableRepeatCoverage >= 95 && flapping === 0,
      actual_percent: stableRepeatCoverage,
      minimum_percent: 95,
      stable_agents: stableTwoRuns,
      eligible_agents: eligible,
      flapping_agents: flapping,
    },
    latest_runs_complete: { pass: incompleteRuns === 0, incomplete_agents: incompleteRuns },
    bundle_evidence_complete: {
      pass: missingBundleEvidence === 0,
      agents_missing_evidence: missingBundleEvidence,
    },
    sandbox_bundle_projection_resolved: {
      pass: sandboxUnresolvedBundles === 0,
      unresolved_bundles: sandboxUnresolvedBundles,
    },
    failures_attributed: { pass: unattributedFailures === 0, unattributed_failures: unattributedFailures },
  };
  const blockingReasons = Object.entries(gates)
    .filter(([, gate]) => !gate.pass)
    .map(([name]) => name);

  const manualReviewReasons: string[] = [];
  if (numeric(summary, 'public_passing_not_spec_passing') > 0) {
    manualReviewReasons.push('public_passing_not_spec_passing');
  }
  if (
    numeric(summary, 'active_badges_not_spec_passing') > 0 ||
    numeric(summary, 'active_badges_not_sandbox_passing') > 0
  ) {
    manualReviewReasons.push('affected_active_or_degraded_badges');
  }
  if (numeric(summary, 'ambiguous_mixed_phases') > 0) {
    manualReviewReasons.push('ambiguous_mixed_controller_failure_phases');
  }
  if (numeric(summary, 'failing_bundles') > 0 || numeric(summary, 'incomplete_bundles') > 0) {
    manualReviewReasons.push('candidate_nonpassing_bundles');
  }
  if (
    numeric(summary, 'legacy_badges_carrying_retired_live') > 0 ||
    numeric(summary, 'legacy_badges_carrying_multiple_modes') > 0 ||
    numeric(summary, 'legacy_badges_active_on_unmonitored_lifecycle') > 0
  ) {
    manualReviewReasons.push('legacy_badge_owner_decision');
  }

  return {
    automatic_gates_pass: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
    manual_review_reasons: manualReviewReasons,
    gates,
  };
}

function agentReasons(agent: Record<string, unknown>): {
  blocking_reasons: string[];
  review_reasons: string[];
} {
  const blocking: string[] = [];
  if (numeric(agent, 'run_count') < 2) blocking.push('fewer_than_two_runs');
  if (numeric(agent, 'transition_count') > 0) blocking.push('candidate_outcome_flapping');
  if (agent.run_complete !== true) blocking.push('latest_run_incomplete');
  if (agent.bundle_evidence_present !== true) blocking.push('bundle_evidence_missing');
  if (agent.sandbox_eligible === true && numeric(agent, 'sandbox_unresolved_bundle_count') > 0) {
    blocking.push('sandbox_bundle_projection_unresolved');
  }
  if (numeric(agent, 'unattributed_failure_count') > 0) blocking.push('unattributed_failures');

  const review: string[] = [];
  if (agent.current_public_status === 'passing' && agent.proposed_spec_status !== 'passing') {
    review.push('public_passing_not_spec_passing');
  }
  if (numeric(agent, 'mixed_controller_failure_phase_count') > 0) {
    review.push('ambiguous_mixed_controller_failure_phases');
  }
  if (numeric(agent, 'failing_bundle_count') > 0 || numeric(agent, 'incomplete_bundle_count') > 0) {
    review.push('candidate_nonpassing_bundles');
  }
  const activeBadges = Array.isArray(agent.active_badges)
    ? agent.active_badges as Array<{ verification_modes?: unknown }>
    : [];
  const affectedActiveBadge = activeBadges.some((badge) => {
    const modes = Array.isArray(badge.verification_modes) ? badge.verification_modes : [];
    return (
      (modes.includes('spec') && agent.proposed_spec_status !== 'passing') ||
      (modes.includes('sandbox') && agent.proposed_sandbox_status !== 'passing')
    );
  });
  if (affectedActiveBadge) {
    review.push('active_or_degraded_badge_affected');
  }
  return { blocking_reasons: blocking, review_reasons: review };
}

export async function runAudit(args: string[]): Promise<Record<string, unknown>> {
  const hours = parseHours(args);
  const includeAgents = args.includes('--include-agents');
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) throw new Error('DATABASE_URL is required');

  initializeDatabase(dbConfig);
  const pool = getPool();
  const aggregate = await pool.query(
    `WITH known_agents AS (
       SELECT agent_url FROM discovered_agents
       UNION
       SELECT agent_url FROM agent_registry_metadata
       UNION
       SELECT a->>'url' AS agent_url
       FROM member_profiles, jsonb_array_elements(agents) a
       WHERE a->>'url' IS NOT NULL
     ),
     eligible AS (
       SELECT ka.agent_url, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage
       FROM known_agents ka
       LEFT JOIN agent_registry_metadata m ON m.agent_url = ka.agent_url
       WHERE ka.agent_url IS NOT NULL
         AND COALESCE(m.lifecycle_stage, 'production') IN ('testing', 'production')
         AND COALESCE(m.compliance_opt_out, FALSE) = FALSE
         AND COALESCE(m.monitoring_paused, FALSE) = FALSE
     ),
     windowed AS (
       SELECT s.*,
              ROW_NUMBER() OVER (PARTITION BY s.agent_url ORDER BY s.evaluated_at DESC, s.id DESC) AS recency,
              jsonb_build_array(
                s.adcp_version, s.proposed_spec_status, s.proposed_sandbox_status,
                s.recommended_profile, s.run_complete, s.bundle_evidence_present,
                s.failing_bundle_count, s.incomplete_bundle_count,
                s.sandbox_unresolved_bundle_count, s.unattributed_failure_count
              ) AS outcome_fingerprint
       FROM verification_profile_shadow_assessments s
       JOIN eligible e ON e.agent_url = s.agent_url
         AND e.lifecycle_stage = s.lifecycle_stage
       WHERE s.policy_version = $1
         AND s.evaluated_at >= NOW() - make_interval(hours => $2)
     ),
     ordered AS (
       SELECT w.*,
              LAG(outcome_fingerprint) OVER (
                PARTITION BY agent_url ORDER BY evaluated_at, id
              ) AS previous_outcome_fingerprint
       FROM windowed w
     ),
     stability AS (
       SELECT agent_url,
              COUNT(*)::int AS run_count,
              COUNT(DISTINCT outcome_fingerprint)::int AS outcome_variant_count,
              COUNT(*) FILTER (
                WHERE previous_outcome_fingerprint IS NOT NULL
                  AND previous_outcome_fingerprint IS DISTINCT FROM outcome_fingerprint
              )::int AS transition_count
       FROM ordered
       GROUP BY agent_url
     ),
     latest AS (
       SELECT w.*, s.run_count, s.outcome_variant_count, s.transition_count
       FROM ordered w
       JOIN stability s USING (agent_url)
       WHERE w.recency = 1
     ),
     badge_impact AS (
       SELECT
         COUNT(*) FILTER (
           WHERE b.status IN ('active', 'degraded')
             AND 'spec' = ANY(b.verification_modes)
             AND l.proposed_spec_status <> 'passing'
         )::int AS active_badges_not_spec_passing,
         COUNT(*) FILTER (
           WHERE b.status IN ('active', 'degraded')
             AND 'sandbox' = ANY(b.verification_modes)
             AND l.sandbox_eligible
             AND l.proposed_sandbox_status <> 'passing'
         )::int AS active_badges_not_sandbox_passing
       FROM agent_verification_badges b
       JOIN latest l ON l.agent_url = b.agent_url
         AND substring(l.adcp_version FROM '^([0-9]+\\.[0-9]+)') = b.adcp_version
     ),
     legacy_badges AS (
       SELECT
         COUNT(*) FILTER (WHERE b.status IN ('active', 'degraded'))::int AS active_or_degraded,
         COUNT(*) FILTER (WHERE 'live' = ANY(b.verification_modes))::int AS carrying_retired_live,
         COUNT(*) FILTER (WHERE cardinality(b.verification_modes) > 1)::int AS carrying_multiple_modes,
         COUNT(*) FILTER (
           WHERE b.status IN ('active', 'degraded')
             AND COALESCE(m.lifecycle_stage, 'production') IN ('development', 'deprecated')
         )::int AS active_on_unmonitored_lifecycle
       FROM agent_verification_badges b
       LEFT JOIN agent_registry_metadata m ON m.agent_url = b.agent_url
     )
     SELECT
       $1::text AS policy_version,
       $2::int AS window_hours,
       COUNT(e.agent_url)::int AS eligible_agents,
       COUNT(l.agent_url)::int AS assessed_agents,
       COUNT(*) FILTER (WHERE l.run_count >= 2)::int AS agents_with_two_or_more_runs,
       COUNT(*) FILTER (WHERE l.run_count >= 2 AND l.outcome_variant_count = 1)::int
         AS agents_with_stable_two_or_more_runs,
       COUNT(*) FILTER (WHERE l.transition_count > 0)::int AS flapping_agents,
       COALESCE(SUM(l.transition_count), 0)::int AS candidate_outcome_transitions,
       COUNT(*) FILTER (WHERE l.current_public_status = 'passing' AND l.proposed_spec_status <> 'passing')::int
         AS public_passing_not_spec_passing,
       COUNT(*) FILTER (WHERE l.current_public_status <> 'passing' AND l.proposed_sandbox_status = 'passing')::int
         AS public_nonpassing_sandbox_passing,
       COUNT(*) FILTER (WHERE l.recommended_profile = 'spec')::int AS recommended_spec,
       COUNT(*) FILTER (WHERE l.recommended_profile = 'sandbox')::int AS recommended_sandbox,
       COUNT(*) FILTER (WHERE l.agent_url IS NOT NULL AND l.recommended_profile IS NULL)::int
         AS eligible_without_recommendation,
       COUNT(*) FILTER (WHERE l.controller_gap_phase_count > 0 OR l.controller_missing_storyboard_count > 0)::int
         AS agents_with_controller_gaps,
       COUNT(*) FILTER (WHERE l.run_complete = FALSE)::int AS incomplete_latest_runs,
       COUNT(*) FILTER (WHERE l.bundle_evidence_present = FALSE)::int AS latest_runs_missing_bundle_evidence,
       COUNT(*) FILTER (WHERE l.mixed_controller_failure_phase_count > 0)::int AS ambiguous_mixed_phases,
       COALESCE(SUM(l.failing_bundle_count), 0)::int AS failing_bundles,
       COALESCE(SUM(l.incomplete_bundle_count), 0)::int AS incomplete_bundles,
       COALESCE(
         SUM(l.sandbox_unresolved_bundle_count) FILTER (WHERE l.sandbox_eligible),
         0
       )::int AS sandbox_unresolved_bundles,
       COALESCE(SUM(l.unattributed_failure_count), 0)::int AS unattributed_failures,
       COALESCE(SUM(l.controller_gap_phase_count), 0)::int AS controller_gap_phases,
       COALESCE(SUM(l.other_missing_storyboard_count), 0)::int AS other_missing_storyboards,
       bi.active_badges_not_spec_passing,
       bi.active_badges_not_sandbox_passing,
       lb.active_or_degraded AS legacy_active_or_degraded_badges,
       lb.carrying_retired_live AS legacy_badges_carrying_retired_live,
       lb.carrying_multiple_modes AS legacy_badges_carrying_multiple_modes,
       lb.active_on_unmonitored_lifecycle AS legacy_badges_active_on_unmonitored_lifecycle
     FROM (SELECT 1) anchor
     CROSS JOIN badge_impact bi
     CROSS JOIN legacy_badges lb
     LEFT JOIN eligible e ON TRUE
     LEFT JOIN latest l ON l.agent_url = e.agent_url
     GROUP BY bi.active_badges_not_spec_passing, bi.active_badges_not_sandbox_passing,
              lb.active_or_degraded, lb.carrying_retired_live,
              lb.carrying_multiple_modes, lb.active_on_unmonitored_lifecycle`,
    [VERIFICATION_PROFILE_SHADOW_POLICY_VERSION, hours],
  );

  const summary = aggregate.rows[0] ?? {};
  const eligibleAgents = numeric(summary, 'eligible_agents');
  const assessedAgents = numeric(summary, 'assessed_agents');
  const report: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    ...summary,
    coverage_percent: calculateCoveragePercent(eligibleAgents, assessedAgents),
    decision: buildDecisionGates(summary),
  };

  if (includeAgents) {
    const details = await pool.query(
      `WITH known_agents AS (
         SELECT agent_url FROM discovered_agents
         UNION
         SELECT agent_url FROM agent_registry_metadata
         UNION
         SELECT a->>'url' AS agent_url
         FROM member_profiles, jsonb_array_elements(agents) a
         WHERE a->>'url' IS NOT NULL
       ),
       eligible AS (
         SELECT ka.agent_url, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage
         FROM known_agents ka
         LEFT JOIN agent_registry_metadata m ON m.agent_url = ka.agent_url
         WHERE ka.agent_url IS NOT NULL
           AND COALESCE(m.lifecycle_stage, 'production') IN ('testing', 'production')
           AND COALESCE(m.compliance_opt_out, FALSE) = FALSE
           AND COALESCE(m.monitoring_paused, FALSE) = FALSE
       ),
       ranked AS (
         SELECT s.*,
                ROW_NUMBER() OVER (PARTITION BY s.agent_url ORDER BY s.evaluated_at DESC, s.id DESC) AS recency,
                jsonb_build_array(
                  s.adcp_version, s.proposed_spec_status, s.proposed_sandbox_status,
                  s.recommended_profile, s.run_complete, s.bundle_evidence_present,
                  s.failing_bundle_count, s.incomplete_bundle_count,
                  s.sandbox_unresolved_bundle_count, s.unattributed_failure_count
                ) AS outcome_fingerprint
         FROM verification_profile_shadow_assessments s
         JOIN eligible e ON e.agent_url = s.agent_url
           AND e.lifecycle_stage = s.lifecycle_stage
         WHERE s.policy_version = $1
           AND s.evaluated_at >= NOW() - make_interval(hours => $2)
       ),
       ordered AS (
         SELECT r.*,
                LAG(outcome_fingerprint) OVER (
                  PARTITION BY agent_url ORDER BY evaluated_at, id
                ) AS previous_outcome_fingerprint
         FROM ranked r
       ),
       stability AS (
         SELECT agent_url,
                COUNT(*)::int AS run_count,
                COUNT(DISTINCT outcome_fingerprint)::int AS outcome_variant_count,
                COUNT(*) FILTER (
                  WHERE previous_outcome_fingerprint IS NOT NULL
                    AND previous_outcome_fingerprint IS DISTINCT FROM outcome_fingerprint
                )::int AS transition_count
         FROM ordered
         GROUP BY agent_url
       )
       SELECT e.agent_url, e.lifecycle_stage, r.adcp_version, r.current_public_status,
              r.proposed_spec_status, r.proposed_sandbox_status, r.recommended_profile,
              r.sandbox_eligible,
              r.run_complete, r.bundle_evidence_present, r.failing_bundle_count,
              r.incomplete_bundle_count, r.sandbox_unresolved_bundle_count,
              r.unattributed_failure_count,
              s.run_count, s.outcome_variant_count, s.transition_count,
              r.controller_gap_phase_count,
              r.controller_missing_storyboard_count, r.other_missing_storyboard_count,
              r.mixed_controller_failure_phase_count, r.evaluated_at,
              COALESCE(badges.active_badges, '[]'::jsonb) AS active_badges
       FROM eligible e
       LEFT JOIN ordered r ON r.agent_url = e.agent_url AND r.recency = 1
       LEFT JOIN stability s ON s.agent_url = e.agent_url
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'role', b.role,
             'adcp_version', b.adcp_version,
             'status', b.status,
             'verification_modes', b.verification_modes
           ) ORDER BY b.role, b.adcp_version
         ) AS active_badges
         FROM agent_verification_badges b
         WHERE b.agent_url = e.agent_url
           AND b.adcp_version = substring(r.adcp_version FROM '^([0-9]+\\.[0-9]+)')
           AND b.status IN ('active', 'degraded')
       ) badges ON TRUE
       ORDER BY e.agent_url`,
      [VERIFICATION_PROFILE_SHADOW_POLICY_VERSION, hours],
    );
    report.agents = details.rows.map((row) => ({ ...row, ...agentReasons(row) }));

    const legacyBadges = await pool.query(
      `SELECT b.agent_url, b.role, b.adcp_version, b.status,
              b.verification_modes,
              COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage,
              array_remove(ARRAY[
                CASE WHEN 'live' = ANY(b.verification_modes) THEN 'retired_live_mode' END,
                CASE WHEN cardinality(b.verification_modes) > 1 THEN 'multiple_modes' END,
                CASE
                  WHEN b.status IN ('active', 'degraded')
                    AND COALESCE(m.lifecycle_stage, 'production') IN ('development', 'deprecated')
                  THEN 'active_on_unmonitored_lifecycle'
                END
              ], NULL) AS reason_flags
       FROM agent_verification_badges b
       LEFT JOIN agent_registry_metadata m ON m.agent_url = b.agent_url
       WHERE 'live' = ANY(b.verification_modes)
          OR cardinality(b.verification_modes) > 1
          OR (
            b.status IN ('active', 'degraded')
            AND COALESCE(m.lifecycle_stage, 'production') IN ('development', 'deprecated')
          )
       ORDER BY b.agent_url, b.role, b.adcp_version`,
    );
    report.legacy_badge_cohort = legacyBadges.rows;
  }

  return report;
}

async function main(): Promise<void> {
  try {
    const report = await runAudit(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

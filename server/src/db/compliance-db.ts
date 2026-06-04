import { query, getClient } from './client.js';
import { decrypt as decryptToken } from './encryption.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'compliance-db' });

// =====================================================
// TYPES
// =====================================================

export type LifecycleStage = 'development' | 'testing' | 'production' | 'deprecated';
export type ComplianceStatus = 'passing' | 'degraded' | 'failing' | 'unknown';
export type OverallRunStatus = 'passing' | 'failing' | 'partial';
export type TriggeredBy = 'heartbeat' | 'manual' | 'webhook' | 'owner_test';
export type TrackStatus = 'pass' | 'fail' | 'partial' | 'skip' | 'silent';

/**
 * Auth shape resolved from an agent_context for outbound compliance/test
 * requests. Matches the SDK's `TestOptions.auth` union in `@adcp/sdk/testing`.
 * Resolvers return `ResolvedOwnerAuth | undefined`; `undefined` is not part
 * of the domain type so post-null-check call sites don't carry the
 * possibility forward.
 */
export type ResolvedOwnerAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | {
      type: 'oauth';
      tokens: { access_token: string; refresh_token: string; expires_at?: string };
      client?: { client_id: string; client_secret?: string };
    }
  | {
      /**
       * OAuth 2.0 client credentials (RFC 6749 §4.4). The SDK exchanges at
       * `credentials.token_endpoint` before every call and refreshes on 401.
       * `credentials.client_secret` may be a `$ENV:ADCP_OAUTH_<NAME>`
       * reference — the SDK resolves at exchange time.
       */
      type: 'oauth_client_credentials';
      credentials: {
        token_endpoint: string;
        client_id: string;
        client_secret: string;
        scope?: string;
        resource?: string;
        audience?: string;
        auth_method?: 'basic' | 'body';
      };
    };

/**
 * Decode an HTTP Basic Authorization credential (base64(`username:password`))
 * into a typed shape. Returns null when the payload has no `:` separator —
 * callers should fall back to treating the raw token as bearer.
 */
export function decodeBasicCredentials(
  token: string,
): { type: 'basic'; username: string; password: string } | null {
  const decoded = Buffer.from(token, 'base64').toString();
  const colonIndex = decoded.indexOf(':');
  if (colonIndex < 0) return null;
  return {
    type: 'basic',
    username: decoded.slice(0, colonIndex),
    password: decoded.slice(colonIndex + 1),
  };
}

export interface AgentRegistryMetadata {
  agent_url: string;
  lifecycle_stage: LifecycleStage;
  compliance_opt_out: boolean;
  monitoring_paused: boolean;
  check_interval_hours: number;
  monitoring_paused_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A single advisory notice emitted by the compliance runner at run-summary
 * level. Defined in static/compliance/source/universal/runner-output-contract.yaml.
 *
 * Forward-compat: receivers MUST treat unknown `code` and `severity` values as
 * well-formed and surface them verbatim — do not validate or filter these fields.
 */
export interface NoticeEntry {
  severity: string;
  code: string;
  message: string;
  effective_version?: string | null;
  capability_path?: string | null;
  reference_url?: string | null;
}

export interface ComplianceRun {
  id: string;
  agent_url: string;
  requested_compliance_target: string | null;
  adcp_version: string | null;
  lifecycle_stage: LifecycleStage;
  overall_status: OverallRunStatus;
  headline: string | null;
  total_duration_ms: number | null;
  tested_at: Date;
  tracks_json: TrackSummaryEntry[];
  tracks_passed: number;
  tracks_failed: number;
  tracks_skipped: number;
  tracks_partial: number;
  agent_profile_json: any;
  observations_json: any;
  triggered_by: TriggeredBy;
  triggered_org_id: string | null;
  dry_run: boolean;
  notices_json: NoticeEntry[] | null;
}

export interface TrackSummaryEntry {
  track: string;
  status: TrackStatus;
  scenario_count: number;
  passed_count: number;
  duration_ms: number;
  has_coverage_gap_skip?: boolean;
}

export interface AgentComplianceStatus {
  agent_url: string;
  requested_compliance_target: string | null;
  adcp_version: string | null;
  status: ComplianceStatus;
  lifecycle_stage: LifecycleStage;
  last_checked_at: Date | null;
  last_passed_at: Date | null;
  last_failed_at: Date | null;
  streak_days: number;
  streak_started_at: Date | null;
  tracks_summary_json: Record<string, string> | null;
  headline: string | null;
  previous_status: string | null;
  status_changed_at: Date | null;
  updated_at: Date;
  /** id of the most recent non-dry-run row in agent_compliance_runs */
  last_run_id: string | null;
  /** triggered_by of the most recent non-dry-run in agent_compliance_runs */
  last_triggered_by: TriggeredBy | null;
  /** tracks_json from the most recent non-dry-run, used for current-run UI details */
  track_details_json?: TrackSummaryEntry[] | null;
}

export interface ComplianceStatusWithStoryboardCounts {
  status: AgentComplianceStatus;
  storyboardCounts: { passing: number; total: number };
}

export type StoryboardStatus = 'passing' | 'failing' | 'partial' | 'untested';
const VALID_STORYBOARD_STATUSES = new Set<StoryboardStatus>(['passing', 'failing', 'partial', 'untested']);

// Badge roles map to AdCP protocols (enums/adcp-protocol.json via adcp-taxonomy).
// Re-exported here as BadgeRole to avoid circular imports.
export type BadgeRole = 'media-buy' | 'creative' | 'signals' | 'governance' | 'brand' | 'sponsored-intelligence';
export type BadgeStatus = 'active' | 'degraded' | 'revoked';

export interface AgentVerificationBadge {
  agent_url: string;
  role: BadgeRole;
  // AdCP release this badge was earned against (MAJOR.MINOR, e.g. '3.0',
  // '3.1'). Part of the composite PK alongside agent_url and role — an
  // agent can hold parallel badges per release. See migration 457.
  adcp_version: string;
  verified_at: Date;
  // Full semver ('3.0.0') for support/audit. Informational; the load-bearing
  // field for badge identity is adcp_version.
  verified_protocol_version: string | null;
  verified_specialisms: string[];
  // Verification axes earned: ['spec'] (storyboards pass), ['spec', 'live']
  // (also observed via canonical campaigns), etc. See VERIFICATION_MODES in
  // services/badge-svg.ts. Stored as TEXT[] in agent_verification_badges.
  verification_modes: string[];
  verification_token: string | null;
  token_expires_at: Date | null;
  membership_org_id: string | null;
  status: BadgeStatus;
  revoked_at: Date | null;
  revocation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Default AdCP version Stage 1 hardcodes everywhere an adcp_version is
 * needed. Replaced by per-call version targeting in Stage 2 once the
 * heartbeat fans out per supported AdCP release.
 */
export const DEFAULT_BADGE_ADCP_VERSION = '3.0';

export interface StoryboardStatusEntry {
  storyboard_id: string;
  requested_compliance_target?: string | null;
  adcp_version?: string | null;
  status: StoryboardStatus;
  steps_passed: number;
  steps_total: number;
}

/**
 * Per-step wire capture for a failing compliance step. Persisted into
 * `agent_compliance_step_diagnostics` so sellers can diff the runner's
 * actual request/response against their own probe without re-running the
 * storyboard themselves. adcp#4738.
 *
 * All fields except the identifying tuple are optional because the SDK
 * does not guarantee every field on every transport (e.g. stdio MCP omits
 * `request_url`, error-path responses have no body). Persist what's there;
 * leave the rest null.
 */
export interface StepDiagnosticEntry {
  storyboard_id: string;
  phase_id: string;
  step_id: string;
  task: string;
  step_passed: boolean;
  duration_ms?: number;
  request_url?: string;
  request_jsonb?: unknown;
  response_status?: number;
  response_headers_jsonb?: Record<string, string>;
  response_jsonb?: unknown;
  extraction_path?: string;
  extraction_note?: string;
  error_text?: string;
  adcp_error_jsonb?: unknown;
  failed_validations_jsonb?: unknown;
  served_by_agent_url?: string;
}

export interface ComplianceStepDiagnosticRow extends StepDiagnosticEntry {
  id: number;
  run_id: string;
  agent_url: string;
  captured_at: Date;
}

export interface RecordComplianceRunInput {
  agent_url: string;
  requested_compliance_target?: string | null;
  adcp_version?: string | null;
  lifecycle_stage: LifecycleStage;
  overall_status: OverallRunStatus;
  headline?: string;
  total_duration_ms?: number;
  tracks_json: TrackSummaryEntry[];
  tracks_passed: number;
  tracks_failed: number;
  tracks_skipped: number;
  tracks_partial: number;
  agent_profile_json?: any;
  observations_json?: any;
  triggered_by?: TriggeredBy;
  /**
   * WorkOS organization id of the org that triggered the run. Populated only
   * for triggered_by='owner_test'; heartbeat / manual / webhook leave it NULL.
   * Required for the per-org scoping of `agent_context_with_latest_test` so
   * two orgs that own the same agent (e.g. staging vs prod orgs of one
   * publisher) don't conflate their test history. See migration 490.
   */
  triggered_org_id?: string | null;
  dry_run?: boolean;
  storyboard_statuses?: StoryboardStatusEntry[];
  /**
   * When true, this run is authoritative for the agent's full storyboard
   * surface. Existing materialized storyboard verdict rows for the agent are
   * deleted before this run's rows are inserted, so removed/skipped storyboards
   * from older runs cannot keep contributing stale pass/fail state.
   *
   * Leave false for partial owner-triggered storyboard reruns; those
   * intentionally overlay one storyboard without discarding the rest.
   */
  replace_storyboard_statuses?: boolean;
  step_diagnostics?: StepDiagnosticEntry[];
  /**
   * Advisory notices emitted by the runner at run-summary level. Stored as
   * JSONB. Forward-compat: unknown codes/severities are preserved verbatim.
   * See NoticeEntry and runner-output-contract.yaml.
   */
  notices_json?: NoticeEntry[] | null;
}

// =====================================================
// COMPLIANCE DATABASE
// =====================================================

export class ComplianceDatabase {

  // ----- Registry Metadata -----

  async upsertRegistryMetadata(
    agentUrl: string,
    updates: { lifecycle_stage?: LifecycleStage; compliance_opt_out?: boolean },
  ): Promise<AgentRegistryMetadata> {
    const result = await query(
      `INSERT INTO agent_registry_metadata (agent_url, lifecycle_stage, compliance_opt_out)
       VALUES ($1, COALESCE($2, 'production'), COALESCE($3, FALSE))
       ON CONFLICT (agent_url) DO UPDATE SET
         lifecycle_stage = COALESCE($2, agent_registry_metadata.lifecycle_stage),
         compliance_opt_out = COALESCE($3, agent_registry_metadata.compliance_opt_out),
         updated_at = NOW()
       RETURNING *`,
      [
        agentUrl,
        updates.lifecycle_stage ?? null,
        updates.compliance_opt_out ?? null,
      ],
    );
    return result.rows[0];
  }

  async getRegistryMetadata(agentUrl: string): Promise<AgentRegistryMetadata | null> {
    const result = await query(
      `SELECT * FROM agent_registry_metadata WHERE agent_url = $1`,
      [agentUrl],
    );
    return result.rows[0] || null;
  }

  /**
   * Check if an agent has auth credentials saved in agent_contexts
   * by the owning organization.
   */
  async hasOwnerAuth(agentUrl: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM agent_contexts ac
       JOIN member_profiles mp ON mp.workos_organization_id = ac.organization_id
       WHERE ac.agent_url = $1
         AND mp.agents @> $2::jsonb
         AND ac.auth_token_encrypted IS NOT NULL
       LIMIT 1`,
      [agentUrl, JSON.stringify([{ url: agentUrl }])],
    );
    return result.rows.length > 0;
  }

  // ----- Compliance Runs -----

  /**
   * Record a compliance run and atomically update the materialized status.
   * Uses a transaction to ensure run and status are consistent.
   * Returns the status transition (previous -> current) for notification logic.
   */
  async recordComplianceRun(input: RecordComplianceRunInput): Promise<{
    run: ComplianceRun;
    statusTransition: { previous: ComplianceStatus; current: ComplianceStatus } | null;
    storyboardStatuses: StoryboardStatusEntry[];
  }> {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // 1. Insert the run
      const runResult = await client.query(
        `INSERT INTO agent_compliance_runs (
          agent_url, requested_compliance_target, adcp_version, lifecycle_stage, overall_status, headline,
          total_duration_ms, tracks_json, tracks_passed, tracks_failed,
          tracks_skipped, tracks_partial, agent_profile_json,
          observations_json, triggered_by, triggered_org_id, dry_run,
          notices_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
        [
          input.agent_url,
          input.requested_compliance_target ?? null,
          input.adcp_version ?? null,
          input.lifecycle_stage,
          input.overall_status,
          input.headline ?? null,
          input.total_duration_ms ?? null,
          JSON.stringify(input.tracks_json),
          input.tracks_passed,
          input.tracks_failed,
          input.tracks_skipped,
          input.tracks_partial,
          input.agent_profile_json ? JSON.stringify(input.agent_profile_json) : null,
          input.observations_json ? JSON.stringify(input.observations_json) : null,
          input.triggered_by ?? 'heartbeat',
          input.triggered_org_id ?? null,
          input.dry_run ?? true,
          input.notices_json ? JSON.stringify(input.notices_json) : null,
        ],
      );
      const run = runResult.rows[0] as ComplianceRun;

      // 2. Compute new status
      const newStatus = this.computeStatus(input.overall_status);

      // 3. Build tracks summary map
      const tracksSummary: Record<string, string> = {};
      for (const t of input.tracks_json) {
        tracksSummary[t.track] = t.status;
      }

      // 4. Upsert the materialized status and capture transition
      const statusResult = await client.query(
        `INSERT INTO agent_compliance_status (
          agent_url, status, last_checked_at,
          last_passed_at, last_failed_at,
          tracks_summary_json, headline, requested_compliance_target, adcp_version,
          previous_status, status_changed_at, updated_at
        ) VALUES (
          $1, $2, NOW(),
          CASE WHEN $2 = 'passing' THEN NOW() ELSE NULL END,
          CASE WHEN $2 IN ('failing', 'degraded') THEN NOW() ELSE NULL END,
          $3, $4, $5, $6,
          NULL, NOW(), NOW()
        )
        ON CONFLICT (agent_url) DO UPDATE SET
          previous_status = agent_compliance_status.status,
          status = $2,
          last_checked_at = NOW(),
          last_passed_at = CASE
            WHEN $2 = 'passing' THEN NOW()
            ELSE agent_compliance_status.last_passed_at
          END,
          last_failed_at = CASE
            WHEN $2 IN ('failing', 'degraded') THEN NOW()
            ELSE agent_compliance_status.last_failed_at
          END,
          status_changed_at = CASE
            WHEN agent_compliance_status.status != $2 THEN NOW()
            ELSE agent_compliance_status.status_changed_at
          END,
          streak_days = CASE
            WHEN $2 = 'passing' AND agent_compliance_status.status = 'passing'
              THEN GREATEST(1, FLOOR(EXTRACT(EPOCH FROM NOW() - COALESCE(agent_compliance_status.streak_started_at, NOW())) / 86400)::INTEGER)
            WHEN $2 = 'passing' AND agent_compliance_status.status != 'passing'
              THEN 0
            ELSE 0
          END,
          streak_started_at = CASE
            WHEN $2 = 'passing' AND agent_compliance_status.status = 'passing'
              THEN agent_compliance_status.streak_started_at
            WHEN $2 = 'passing' AND agent_compliance_status.status != 'passing'
              THEN NOW()
            ELSE NULL
          END,
          tracks_summary_json = $3,
          headline = $4,
          requested_compliance_target = $5,
          adcp_version = $6,
          updated_at = NOW()
        RETURNING status, previous_status`,
        [
          input.agent_url,
          newStatus,
          JSON.stringify(tracksSummary),
          input.headline ?? null,
          input.requested_compliance_target ?? null,
          input.adcp_version ?? null,
        ],
      );

      // 5. Batch upsert per-storyboard statuses (single query, not N+1).
      // Full-suite runs replace the agent's materialized storyboard rows before
      // inserting fresh results. That invalidates stale verdicts from older
      // compliance targets/cache versions while preserving partial overlay
      // semantics for single-storyboard owner retests.
      // Uses a SAVEPOINT so a missing table (pre-migration) doesn't roll back
      // the entire compliance run — the run and status update still commit.
      if (input.replace_storyboard_statuses || input.storyboard_statuses?.length) {
        // Validate status values before sending to Postgres to surface typos
        // as clear errors instead of cryptic constraint violations inside unnest
        for (const sb of input.storyboard_statuses ?? []) {
          if (!VALID_STORYBOARD_STATUSES.has(sb.status)) {
            throw new Error(`Invalid storyboard status "${sb.status}" for ${sb.storyboard_id}`);
          }
        }

        await client.query('SAVEPOINT storyboard_upsert');
        try {
          if (input.replace_storyboard_statuses) {
            if (input.storyboard_statuses?.length) {
              const freshIds = input.storyboard_statuses.map(s => s.storyboard_id);
              await client.query(
                `DELETE FROM agent_storyboard_status
                 WHERE agent_url = $1
                   AND NOT (storyboard_id = ANY($2::text[]))`,
                [input.agent_url, freshIds],
              );
            } else {
              await client.query(
                `DELETE FROM agent_storyboard_status WHERE agent_url = $1`,
                [input.agent_url],
              );
            }
          }

          if (input.storyboard_statuses?.length) {
            const sbIds = input.storyboard_statuses.map(s => s.storyboard_id);
            const sbStatuses = input.storyboard_statuses.map(s => s.status);
            const sbStepsPassed = input.storyboard_statuses.map(s => s.steps_passed);
            const sbStepsTotal = input.storyboard_statuses.map(s => s.steps_total);

            await client.query(
              `INSERT INTO agent_storyboard_status (
                agent_url, storyboard_id, status, last_tested_at,
                last_passed_at, last_failed_at, run_id,
                steps_passed, steps_total, triggered_by, requested_compliance_target, adcp_version, updated_at
              )
              SELECT
                $1, sb_id, sb_status, NOW(),
                CASE WHEN sb_status = 'passing' THEN NOW() ELSE NULL END,
                CASE WHEN sb_status IN ('failing', 'partial') THEN NOW() ELSE NULL END,
                $4, sb_passed, sb_total, $7, $8, $9, NOW()
              FROM unnest($2::text[], $3::text[], $5::int[], $6::int[])
                AS t(sb_id, sb_status, sb_passed, sb_total)
              ON CONFLICT (agent_url, storyboard_id) DO UPDATE SET
                status = EXCLUDED.status,
                last_tested_at = NOW(),
                last_passed_at = CASE
                  WHEN EXCLUDED.status = 'passing' THEN NOW()
                  ELSE agent_storyboard_status.last_passed_at
                END,
                last_failed_at = CASE
                  WHEN EXCLUDED.status IN ('failing', 'partial') THEN NOW()
                  ELSE agent_storyboard_status.last_failed_at
                END,
                run_id = EXCLUDED.run_id,
                steps_passed = EXCLUDED.steps_passed,
                steps_total = EXCLUDED.steps_total,
                triggered_by = EXCLUDED.triggered_by,
                requested_compliance_target = EXCLUDED.requested_compliance_target,
                adcp_version = EXCLUDED.adcp_version,
                updated_at = NOW()`,
              [
                input.agent_url,
                sbIds,
                sbStatuses,
                run.id,
                sbStepsPassed,
                sbStepsTotal,
                input.triggered_by ?? 'heartbeat',
                input.requested_compliance_target ?? null,
                input.adcp_version ?? null,
              ],
            );
          }
          await client.query('RELEASE SAVEPOINT storyboard_upsert');
        } catch (sbErr) {
          await client.query('ROLLBACK TO SAVEPOINT storyboard_upsert');
          logger.warn({ err: sbErr, agentUrl: input.agent_url }, 'Storyboard status upsert failed (table may not exist yet)');
        }
      }

      // 6. Batch insert per-step diagnostics (failing steps only).
      // SAVEPOINT-wrapped so a missing table (pre-migration 489) or a
      // payload that fails column-level constraints doesn't roll back the
      // compliance run itself. Diagnostics are an aid, not the verdict.
      if (input.step_diagnostics?.length) {
        await client.query('SAVEPOINT step_diag_insert');
        try {
          const diag = input.step_diagnostics;
          await client.query(
            `INSERT INTO agent_compliance_step_diagnostics (
              run_id, agent_url, storyboard_id, phase_id, step_id, task,
              step_passed, duration_ms,
              request_url, request_jsonb,
              response_status, response_headers_jsonb, response_jsonb,
              extraction_path, extraction_note,
              error_text, adcp_error_jsonb, failed_validations_jsonb,
              served_by_agent_url
            )
            SELECT
              $1, $2, sb_id, ph_id, st_id, tk,
              passed, dur,
              req_url, req_body::jsonb,
              resp_status, resp_headers::jsonb, resp_body::jsonb,
              ext_path, ext_note,
              err_text, adcp_err::jsonb, failed_v::jsonb,
              served_by
            FROM unnest(
              $3::text[], $4::text[], $5::text[], $6::text[],
              $7::bool[], $8::int[],
              $9::text[], $10::text[],
              $11::int[], $12::text[], $13::text[],
              $14::text[], $15::text[],
              $16::text[], $17::text[], $18::text[],
              $19::text[]
            ) AS t(
              sb_id, ph_id, st_id, tk,
              passed, dur,
              req_url, req_body,
              resp_status, resp_headers, resp_body,
              ext_path, ext_note,
              err_text, adcp_err, failed_v,
              served_by
            )`,
            [
              run.id,
              input.agent_url,
              diag.map(d => d.storyboard_id),
              diag.map(d => d.phase_id),
              diag.map(d => d.step_id),
              diag.map(d => d.task),
              diag.map(d => d.step_passed),
              diag.map(d => d.duration_ms ?? null),
              diag.map(d => d.request_url ?? null),
              diag.map(d => d.request_jsonb !== undefined ? JSON.stringify(d.request_jsonb) : null),
              diag.map(d => d.response_status ?? null),
              diag.map(d => d.response_headers_jsonb !== undefined ? JSON.stringify(d.response_headers_jsonb) : null),
              diag.map(d => d.response_jsonb !== undefined ? JSON.stringify(d.response_jsonb) : null),
              diag.map(d => d.extraction_path ?? null),
              diag.map(d => d.extraction_note ?? null),
              diag.map(d => d.error_text ?? null),
              diag.map(d => d.adcp_error_jsonb !== undefined ? JSON.stringify(d.adcp_error_jsonb) : null),
              diag.map(d => d.failed_validations_jsonb !== undefined ? JSON.stringify(d.failed_validations_jsonb) : null),
              diag.map(d => d.served_by_agent_url ?? null),
            ],
          );
          await client.query('RELEASE SAVEPOINT step_diag_insert');
        } catch (diagErr) {
          await client.query('ROLLBACK TO SAVEPOINT step_diag_insert');
          logger.warn(
            { err: diagErr, agentUrl: input.agent_url, count: input.step_diagnostics.length },
            'Step diagnostics insert failed (table may not exist yet)',
          );
        }
      }

      await client.query('COMMIT');

      const row = statusResult.rows[0];
      const transition = row.previous_status && row.previous_status !== row.status
        ? { previous: row.previous_status as ComplianceStatus, current: row.status as ComplianceStatus }
        : null;

      const storyboardStatuses = (input.storyboard_statuses ?? []).map(s => ({
        ...s,
        requested_compliance_target: s.requested_compliance_target ?? input.requested_compliance_target ?? null,
        adcp_version: s.adcp_version ?? input.adcp_version ?? null,
      }));

      return { run, statusTransition: transition, storyboardStatuses };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ----- Status Queries -----

  async getComplianceStatus(agentUrl: string): Promise<AgentComplianceStatus | null> {
    const result = await query(
      `SELECT s.*, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage,
              r.id AS last_run_id,
              r.triggered_by AS last_triggered_by,
              r.tracks_json AS track_details_json
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       LEFT JOIN LATERAL (
         SELECT id, triggered_by, tracks_json FROM agent_compliance_runs
         WHERE agent_url = s.agent_url AND dry_run = false
         ORDER BY tested_at DESC LIMIT 1
       ) r ON true
       WHERE s.agent_url = $1`,
      [agentUrl],
    );
    return result.rows[0] || null;
  }

  async getComplianceStatusWithStoryboardCounts(agentUrl: string): Promise<ComplianceStatusWithStoryboardCounts | null> {
    const result = await query(
      `SELECT s.*, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage,
              r.id AS last_run_id,
              r.triggered_by AS last_triggered_by,
              r.tracks_json AS track_details_json,
              COALESCE(sb_counts.passing, 0)::int AS storyboards_passing,
              COALESCE(sb_counts.total, 0)::int AS storyboards_total
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       LEFT JOIN LATERAL (
         SELECT id, triggered_by, tracks_json FROM agent_compliance_runs
         WHERE agent_url = s.agent_url AND dry_run = false
         ORDER BY tested_at DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE ss.status = 'passing') AS passing,
           COUNT(*) AS total
         FROM agent_storyboard_status ss
         WHERE ss.agent_url = s.agent_url
           AND (
             r.id IS NULL OR EXISTS (
               SELECT 1 FROM agent_storyboard_status latest
               WHERE latest.agent_url = s.agent_url
                 AND latest.run_id = r.id
             )
           )
       ) sb_counts ON true
       WHERE s.agent_url = $1`,
      [agentUrl],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { storyboards_passing, storyboards_total, ...status } = row;
    return {
      status: status as AgentComplianceStatus,
      storyboardCounts: {
        passing: Number(storyboards_passing ?? 0),
        total: Number(storyboards_total ?? 0),
      },
    };
  }

  async bulkGetRegistryMetadata(agentUrls: string[]): Promise<Map<string, AgentRegistryMetadata>> {
    if (agentUrls.length === 0) return new Map();

    const result = await query(
      `SELECT * FROM agent_registry_metadata WHERE agent_url = ANY($1)`,
      [agentUrls],
    );

    const map = new Map<string, AgentRegistryMetadata>();
    for (const row of result.rows) {
      map.set(row.agent_url, row);
    }
    return map;
  }

  async bulkGetComplianceStatus(agentUrls: string[]): Promise<Map<string, AgentComplianceStatus>> {
    if (agentUrls.length === 0) return new Map();

    const result = await query(
      `SELECT s.*, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage,
              r.id AS last_run_id,
              r.triggered_by AS last_triggered_by,
              r.tracks_json AS track_details_json
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       LEFT JOIN LATERAL (
         SELECT id, triggered_by, tracks_json FROM agent_compliance_runs
         WHERE agent_url = s.agent_url AND dry_run = false
         ORDER BY tested_at DESC LIMIT 1
       ) r ON true
       WHERE s.agent_url = ANY($1)`,
      [agentUrls],
    );

    const map = new Map<string, AgentComplianceStatus>();
    for (const row of result.rows) {
      map.set(row.agent_url, row);
    }
    return map;
  }

  async getComplianceHistory(
    agentUrl: string,
    limit: number = 30,
    opts: { includeDryRuns?: boolean } = {},
  ): Promise<ComplianceRun[]> {
    const result = await query(
      `SELECT * FROM agent_compliance_runs
       WHERE agent_url = $1
         AND ($3::boolean OR dry_run = FALSE)
       ORDER BY tested_at DESC
       LIMIT $2`,
      [agentUrl, limit, opts.includeDryRuns ?? false],
    );
    return result.rows;
  }

  /**
   * Fetch per-step diagnostics for a single compliance run.
   *
   * If `runId` is omitted, resolves to the latest run for the agent. Returns
   * an empty array when no run exists or no failing steps were captured.
   * Diagnostics are owner-only PII (request bodies can contain seller-side
   * account identifiers, brand domains, etc.) — callers are responsible for
   * gating with the appropriate ownership middleware.
   */
  async getStepDiagnostics(
    agentUrl: string,
    opts: { runId?: string; limit?: number } = {},
  ): Promise<ComplianceStepDiagnosticRow[]> {
    const limit = Math.min(opts.limit ?? 500, 1000);
    if (opts.runId) {
      const result = await query(
        `SELECT id, run_id, agent_url, storyboard_id, phase_id, step_id, task,
                step_passed, duration_ms,
                request_url, request_jsonb,
                response_status, response_headers_jsonb, response_jsonb,
                extraction_path, extraction_note,
                error_text, adcp_error_jsonb, failed_validations_jsonb,
                served_by_agent_url, captured_at
         FROM agent_compliance_step_diagnostics
         WHERE run_id = $1 AND agent_url = $2
         ORDER BY storyboard_id, phase_id, step_id
         LIMIT $3`,
        [opts.runId, agentUrl, limit],
      );
      return result.rows;
    }

    // Latest run by tested_at — diagnostics are joined via run_id.
    const result = await query(
      `WITH latest AS (
         SELECT id FROM agent_compliance_runs
         WHERE agent_url = $1
         ORDER BY tested_at DESC
         LIMIT 1
       )
       SELECT d.id, d.run_id, d.agent_url, d.storyboard_id, d.phase_id, d.step_id, d.task,
              d.step_passed, d.duration_ms,
              d.request_url, d.request_jsonb,
              d.response_status, d.response_headers_jsonb, d.response_jsonb,
              d.extraction_path, d.extraction_note,
              d.error_text, d.adcp_error_jsonb, d.failed_validations_jsonb,
              d.served_by_agent_url, d.captured_at
       FROM agent_compliance_step_diagnostics d
       JOIN latest l ON d.run_id = l.id
       WHERE d.agent_url = $1
       ORDER BY d.storyboard_id, d.phase_id, d.step_id
       LIMIT $2`,
      [agentUrl, limit],
    );
    return result.rows;
  }

  async getLatestDeclaredSpecialisms(agentUrl: string): Promise<string[]> {
    const result = await query(
      `SELECT agent_profile_json
       FROM agent_compliance_runs
       WHERE agent_url = $1
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    const profile = result.rows[0]?.agent_profile_json;
    const list = profile?.specialisms;
    if (list != null && !Array.isArray(list)) {
      logger.debug({ agentUrl, specialismsType: typeof list }, 'agent_profile_json.specialisms is not an array');
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list.filter((s: unknown): s is string => typeof s === 'string');
  }

  /**
   * Return the notices_json array from the most recent non-dry-run compliance
   * run for the agent. Returns an empty array when no run exists or when the
   * latest run stored no notices.
   *
   * Forward-compat: unknown codes/severities are preserved verbatim — callers
   * MUST NOT validate or filter notice.code / notice.severity values.
   */
  async getLatestNotices(agentUrl: string): Promise<NoticeEntry[]> {
    const result = await query(
      `SELECT notices_json
       FROM agent_compliance_runs
       WHERE agent_url = $1 AND dry_run = FALSE
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    const raw = result.rows[0]?.notices_json;
    if (!Array.isArray(raw)) return [];
    return raw as NoticeEntry[];
  }

  /**
   * Return advisory observations from the most recent non-dry-run compliance
   * run. These are fresh per-run observations from the runner (for example
   * best-practice advisories); consumers must not merge them with older runs.
   */
  async getLatestObservations(agentUrl: string): Promise<unknown[]> {
    const result = await query(
      `SELECT observations_json
       FROM agent_compliance_runs
       WHERE agent_url = $1 AND dry_run = FALSE
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    const raw = result.rows[0]?.observations_json;
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  // ----- Due-for-Check Query -----

  /**
   * Find agents that are due for a compliance check based on their lifecycle stage.
   * Joins federated agents (from discovered_agents + member profiles) with metadata and status.
   * Respects owner-configured check_interval_hours and monitoring_paused.
   */
  async getAgentsDueForCheck(limit: number = 10): Promise<Array<{
    agent_url: string;
    lifecycle_stage: LifecycleStage;
    last_checked_at: Date | null;
  }>> {
    // `known_agents` unions every source the heartbeat is allowed to test:
    //
    // - `discovered_agents` — crawler-discovered via adagents.json on a
    //   publisher domain.
    // - `agent_registry_metadata` — explicit registration / lifecycle-stage
    //   write. Most member-registered agents land a row here via the
    //   write-side seed in member-agents.ts and the save_agent MCP handler.
    // - `member_profiles.agents` (JSONB) — defense-in-depth: any agent the
    //   owner registered through Addie or the REST surface, even if the
    //   metadata-row seed failed (the seed is best-effort with a warn-log
    //   on failure). Without this third leg of the union, an agent that
    //   slipped past the seed would stay `unknown` forever — the same
    //   class of bug as the operator-endpoint visibility miss.
    //
    // ORDER BY adds `agent_url` as a deterministic tiebreaker so two
    // never-checked agents land in a stable order across heartbeat runs.
    const result = await query(
      `WITH known_agents AS (
        SELECT agent_url FROM discovered_agents
        UNION
        SELECT agent_url FROM agent_registry_metadata
        UNION
        SELECT (a->>'url') AS agent_url
        FROM member_profiles, jsonb_array_elements(agents) a
        WHERE a->>'url' IS NOT NULL
      )
      SELECT
        ka.agent_url,
        COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage,
        s.last_checked_at
      FROM known_agents ka
      LEFT JOIN agent_registry_metadata m ON m.agent_url = ka.agent_url
      LEFT JOIN agent_compliance_status s ON s.agent_url = ka.agent_url
      WHERE
        COALESCE(m.lifecycle_stage, 'production') IN ('production', 'testing')
        AND COALESCE(m.compliance_opt_out, FALSE) = FALSE
        AND COALESCE(m.monitoring_paused, FALSE) = FALSE
        AND (
          s.last_checked_at IS NULL
          OR s.last_checked_at < NOW() - make_interval(hours => COALESCE(m.check_interval_hours,
            CASE WHEN COALESCE(m.lifecycle_stage, 'production') = 'testing' THEN 24 ELSE 12 END
          ))
        )
      ORDER BY s.last_checked_at ASC NULLS FIRST, ka.agent_url ASC
      LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  // ----- Monitoring Settings -----

  async getMonitoringSettings(agentUrl: string): Promise<{
    monitoring_paused: boolean;
    check_interval_hours: number;
    monitoring_paused_at: Date | null;
  }> {
    const result = await query(
      `SELECT monitoring_paused, check_interval_hours, monitoring_paused_at
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [agentUrl],
    );
    if (result.rows.length === 0) {
      return { monitoring_paused: false, check_interval_hours: 12, monitoring_paused_at: null };
    }
    return result.rows[0];
  }

  async updateMonitoringPaused(agentUrl: string, paused: boolean): Promise<void> {
    await query(
      `INSERT INTO agent_registry_metadata (agent_url, monitoring_paused, monitoring_paused_at)
       VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END)
       ON CONFLICT (agent_url) DO UPDATE SET
         monitoring_paused = $2,
         monitoring_paused_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
         updated_at = NOW()`,
      [agentUrl, paused],
    );
  }

  async updateCheckInterval(agentUrl: string, intervalHours: number): Promise<void> {
    await query(
      `INSERT INTO agent_registry_metadata (agent_url, check_interval_hours)
       VALUES ($1, $2)
       ON CONFLICT (agent_url) DO UPDATE SET
         check_interval_hours = $2,
         updated_at = NOW()`,
      [agentUrl, intervalHours],
    );
  }

  async requeueForHeartbeat(agentUrl: string): Promise<void> {
    await query(
      `INSERT INTO agent_compliance_status (agent_url, status, last_checked_at)
       VALUES ($1, 'unknown', NULL)
       ON CONFLICT (agent_url) DO UPDATE SET last_checked_at = NULL`,
      [agentUrl],
    );
  }

  // ----- Storyboard Status Queries -----

  async getStoryboardStatuses(agentUrl: string, options: {
    runId?: string | null;
    requireRowsForRunId?: string | null;
    requireRowsForLatestRun?: boolean;
  } = {}): Promise<Array<{
    storyboard_id: string;
    requested_compliance_target: string | null;
    adcp_version: string | null;
    status: string;
    last_tested_at: Date | null;
    last_passed_at: Date | null;
    last_failed_at: Date | null;
    steps_passed: number;
    steps_total: number;
    triggered_by: string | null;
  }>> {
    const result = await query(
      `WITH latest_run AS (
         SELECT id
         FROM agent_compliance_runs
         WHERE agent_url = $1
           AND dry_run = false
         ORDER BY tested_at DESC
         LIMIT 1
       )
       SELECT storyboard_id, requested_compliance_target, adcp_version, status, last_tested_at, last_passed_at, last_failed_at,
              steps_passed, steps_total, triggered_by
       FROM agent_storyboard_status s
       WHERE s.agent_url = $1
         AND ($2::uuid IS NULL OR s.run_id = $2::uuid)
         AND (
           $3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM agent_storyboard_status latest
             WHERE latest.agent_url = $1
               AND latest.run_id = $3::uuid
           )
         )
         AND (
           $4::boolean = false
           OR NOT EXISTS (SELECT 1 FROM latest_run)
           OR EXISTS (
             SELECT 1 FROM agent_storyboard_status latest
             JOIN latest_run lr ON latest.run_id = lr.id
             WHERE latest.agent_url = $1
           )
         )
       ORDER BY storyboard_id`,
      [agentUrl, options.runId ?? null, options.requireRowsForRunId ?? null, options.requireRowsForLatestRun === true],
    );
    return result.rows;
  }

  async getStoryboardStatusCounts(agentUrl: string, options: {
    runId?: string | null;
    requireRowsForRunId?: string | null;
    requireRowsForLatestRun?: boolean;
  } = {}): Promise<{ passing: number; total: number }> {
    const result = await query(
      `WITH latest_run AS (
         SELECT id
         FROM agent_compliance_runs
         WHERE agent_url = $1
           AND dry_run = false
         ORDER BY tested_at DESC
         LIMIT 1
       )
       SELECT
         COUNT(*) FILTER (WHERE status = 'passing') AS passing,
         COUNT(*) AS total
       FROM agent_storyboard_status s
       WHERE s.agent_url = $1
         AND ($2::uuid IS NULL OR s.run_id = $2::uuid)
         AND (
           $3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM agent_storyboard_status latest
             WHERE latest.agent_url = $1
               AND latest.run_id = $3::uuid
           )
         )
         AND (
           $4::boolean = false
           OR NOT EXISTS (SELECT 1 FROM latest_run)
           OR EXISTS (
             SELECT 1 FROM agent_storyboard_status latest
             JOIN latest_run lr ON latest.run_id = lr.id
             WHERE latest.agent_url = $1
           )
         )`,
      [agentUrl, options.runId ?? null, options.requireRowsForRunId ?? null, options.requireRowsForLatestRun === true],
    );
    const row = result.rows[0];
    return { passing: parseInt(row?.passing ?? '0'), total: parseInt(row?.total ?? '0') };
  }

  async bulkGetStoryboardStatuses(agentUrls: string[]): Promise<Map<string, Array<{
    storyboard_id: string;
    requested_compliance_target: string | null;
    adcp_version: string | null;
    status: string;
    last_tested_at: Date | null;
    last_passed_at: Date | null;
    steps_passed: number;
    steps_total: number;
  }>>> {
    if (agentUrls.length === 0) return new Map();

    const result = await query(
      `WITH latest_runs AS (
         SELECT DISTINCT ON (agent_url) agent_url, id
         FROM agent_compliance_runs
         WHERE agent_url = ANY($1)
           AND dry_run = false
         ORDER BY agent_url, tested_at DESC
       ),
       latest_run_flags AS (
         SELECT
           lr.agent_url,
           EXISTS (
             SELECT 1 FROM agent_storyboard_status latest
             WHERE latest.agent_url = lr.agent_url
               AND latest.run_id = lr.id
           ) AS has_rows
         FROM latest_runs lr
       )
       SELECT s.agent_url, s.storyboard_id, s.requested_compliance_target, s.adcp_version, s.status, s.last_tested_at, s.last_passed_at,
              s.steps_passed, s.steps_total
       FROM agent_storyboard_status s
       LEFT JOIN latest_run_flags lf ON lf.agent_url = s.agent_url
       WHERE s.agent_url = ANY($1)
         AND COALESCE(lf.has_rows, true) = true
       ORDER BY s.agent_url, s.storyboard_id`,
      [agentUrls],
    );

    const map = new Map<string, Array<{
      storyboard_id: string; requested_compliance_target: string | null; adcp_version: string | null; status: string;
      last_tested_at: Date | null; last_passed_at: Date | null;
      steps_passed: number; steps_total: number;
    }>>();
    for (const row of result.rows) {
      if (!map.has(row.agent_url)) map.set(row.agent_url, []);
      map.get(row.agent_url)!.push(row);
    }
    return map;
  }

  // ----- Helpers -----

  /**
   * Resolve auth credentials for an agent from the owning organization's
   * saved tokens in agent_contexts. Only uses credentials from the org
   * that owns the agent (via member_profiles.agents), not arbitrary orgs.
   *
   * Returns the full `oauth` shape when a refresh token is saved so the
   * @adcp/sdk SDK can refresh on 401 instead of failing once the access
   * token drifts near expiry. Without a refresh token, returns the raw
   * access token as a bearer so callers surface a clear 401 from the agent
   * rather than sending no Authorization header at all.
   */
  async resolveOwnerAuth(agentUrl: string): Promise<ResolvedOwnerAuth | undefined> {
    try {
      const result = await query(
        `SELECT ac.organization_id,
                ac.auth_token_encrypted, ac.auth_token_iv, ac.auth_type,
                ac.oauth_access_token_encrypted, ac.oauth_access_token_iv,
                ac.oauth_refresh_token_encrypted, ac.oauth_refresh_token_iv,
                ac.oauth_token_expires_at,
                ac.oauth_client_id,
                ac.oauth_client_secret_encrypted, ac.oauth_client_secret_iv,
                ac.oauth_cc_token_endpoint, ac.oauth_cc_client_id,
                ac.oauth_cc_client_secret_encrypted, ac.oauth_cc_client_secret_iv,
                ac.oauth_cc_scope, ac.oauth_cc_resource, ac.oauth_cc_audience, ac.oauth_cc_auth_method
         FROM agent_contexts ac
         JOIN member_profiles mp
           ON mp.workos_organization_id = ac.organization_id
         WHERE ac.agent_url = $1
           AND mp.agents @> $2::jsonb
           AND (
             ac.auth_token_encrypted IS NOT NULL
             OR ac.oauth_access_token_encrypted IS NOT NULL
             OR (
               ac.oauth_cc_token_endpoint IS NOT NULL
               AND ac.oauth_cc_client_id IS NOT NULL
               AND ac.oauth_cc_client_secret_encrypted IS NOT NULL
             )
           )
         ORDER BY ac.updated_at DESC NULLS LAST
         LIMIT 1`,
        [agentUrl, JSON.stringify([{ url: agentUrl }])],
      );

      const row = result.rows[0];
      if (!row) return undefined;

      // Prefer static token when available
      if (row.auth_token_encrypted) {
        const token = decryptToken(row.auth_token_encrypted, row.auth_token_iv, row.organization_id);

        if (row.auth_type === 'basic') {
          const basic = decodeBasicCredentials(token);
          if (basic) return basic;
        }

        return { type: 'bearer', token };
      }

      if (row.oauth_access_token_encrypted && row.oauth_access_token_iv) {
        const accessToken = decryptToken(
          row.oauth_access_token_encrypted,
          row.oauth_access_token_iv,
          row.organization_id,
        );

        const refreshToken = row.oauth_refresh_token_encrypted && row.oauth_refresh_token_iv
          ? decryptToken(row.oauth_refresh_token_encrypted, row.oauth_refresh_token_iv, row.organization_id)
          : undefined;

        if (!refreshToken) {
          return { type: 'bearer', token: accessToken };
        }

        const tokens: { access_token: string; refresh_token: string; expires_at?: string } = {
          access_token: accessToken,
          refresh_token: refreshToken,
        };
        if (row.oauth_token_expires_at) {
          tokens.expires_at = new Date(row.oauth_token_expires_at).toISOString();
        }

        const oauth: Extract<ResolvedOwnerAuth, { type: 'oauth' }> = { type: 'oauth', tokens };
        if (row.oauth_client_id) {
          const client: { client_id: string; client_secret?: string } = { client_id: row.oauth_client_id };
          if (row.oauth_client_secret_encrypted && row.oauth_client_secret_iv) {
            client.client_secret = decryptToken(
              row.oauth_client_secret_encrypted,
              row.oauth_client_secret_iv,
              row.organization_id,
            );
          }
          oauth.client = client;
        }
        return oauth;
      }

      if (
        row.oauth_cc_token_endpoint &&
        row.oauth_cc_client_id &&
        row.oauth_cc_client_secret_encrypted &&
        row.oauth_cc_client_secret_iv
      ) {
        const clientSecret = decryptToken(
          row.oauth_cc_client_secret_encrypted,
          row.oauth_cc_client_secret_iv,
          row.organization_id,
        );
        const credentials: Extract<ResolvedOwnerAuth, { type: 'oauth_client_credentials' }>['credentials'] = {
          token_endpoint: row.oauth_cc_token_endpoint,
          client_id: row.oauth_cc_client_id,
          client_secret: clientSecret,
        };
        if (row.oauth_cc_scope) credentials.scope = row.oauth_cc_scope;
        if (row.oauth_cc_resource) credentials.resource = row.oauth_cc_resource;
        if (row.oauth_cc_audience) credentials.audience = row.oauth_cc_audience;
        if (row.oauth_cc_auth_method === 'basic' || row.oauth_cc_auth_method === 'body') {
          credentials.auth_method = row.oauth_cc_auth_method;
        } else if (row.oauth_cc_auth_method !== null && row.oauth_cc_auth_method !== undefined) {
          // Drop values outside the SDK's accepted enum rather than poisoning
          // the return type — but log it. An unexpected value here means a
          // write path bypassed validation, which is a latent bug worth
          // surfacing before it spreads.
          logger.warn(
            { agentUrl, orgId: row.organization_id, value: row.oauth_cc_auth_method },
            'Dropped unrecognized oauth_cc_auth_method from agent_context',
          );
        }
        return { type: 'oauth_client_credentials', credentials };
      }

      return undefined;
    } catch (error) {
      logger.warn({ err: error, agentUrl }, 'Could not resolve owner auth');
      return undefined;
    }
  }

  // ----- Verification Badges -----

  async upsertBadge(badge: {
    agent_url: string;
    role: BadgeRole;
    adcp_version: string;
    verified_specialisms: string[];
    verification_modes?: string[];
    verified_protocol_version?: string;
    verification_token?: string;
    token_expires_at?: Date;
    membership_org_id?: string;
  }): Promise<AgentVerificationBadge> {
    const modes = badge.verification_modes ?? ['spec'];
    const result = await query(
      `INSERT INTO agent_verification_badges (
        agent_url, role, adcp_version, verified_specialisms, verification_modes, verified_protocol_version,
        verification_token, token_expires_at, membership_org_id,
        status, verified_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW(), NOW())
      ON CONFLICT (agent_url, role, adcp_version) DO UPDATE SET
        verified_specialisms = $4,
        verification_modes = $5,
        verified_protocol_version = COALESCE($6, agent_verification_badges.verified_protocol_version),
        verification_token = COALESCE($7, agent_verification_badges.verification_token),
        token_expires_at = COALESCE($8, agent_verification_badges.token_expires_at),
        membership_org_id = COALESCE($9, agent_verification_badges.membership_org_id),
        status = 'active',
        verified_at = CASE WHEN agent_verification_badges.status = 'degraded' THEN NOW() ELSE agent_verification_badges.verified_at END,
        revoked_at = NULL,
        revocation_reason = NULL,
        updated_at = NOW()
      RETURNING *`,
      [
        badge.agent_url,
        badge.role,
        badge.adcp_version,
        badge.verified_specialisms,
        modes,
        badge.verified_protocol_version ?? null,
        badge.verification_token ?? null,
        badge.token_expires_at ?? null,
        badge.membership_org_id ?? null,
      ],
    );
    return result.rows[0] as AgentVerificationBadge;
  }

  async getBadgesForAgent(agentUrl: string): Promise<AgentVerificationBadge[]> {
    // Numeric sort on adcp_version: split MAJOR.MINOR and compare each
    // segment as int so '10.0' sorts above '3.0'. Text sort would
    // serve a stale older badge once the spec hits double-digit
    // major or minor numbers. CHECK constraint guarantees both
    // segments are valid integers.
    const result = await query(
      `SELECT * FROM agent_verification_badges
       WHERE agent_url = $1 AND status IN ('active', 'degraded')
       ORDER BY split_part(adcp_version, '.', 1)::int DESC,
                split_part(adcp_version, '.', 2)::int DESC,
                role`,
      [agentUrl],
    );
    return result.rows as AgentVerificationBadge[];
  }

  /**
   * Returns the active badge for an agent+role at a specific AdCP version.
   * Stage 2 will use this when the heartbeat fans out per version. Stage 1
   * callers pass DEFAULT_BADGE_ADCP_VERSION.
   */
  async getActiveBadge(
    agentUrl: string,
    role: BadgeRole,
    adcpVersion: string,
  ): Promise<AgentVerificationBadge | null> {
    const result = await query(
      `SELECT * FROM agent_verification_badges
       WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
         AND status IN ('active', 'degraded')`,
      [agentUrl, role, adcpVersion],
    );
    return (result.rows[0] as AgentVerificationBadge) ?? null;
  }

  /**
   * Returns the highest-version active badge for an agent+role.
   *
   * Powers the legacy `/badge/{role}.svg` URL — embedded badges in the
   * wild auto-upgrade to the most recent version the agent has earned
   * without changing the URL. The version-specific URL
   * `/badge/{role}/{version}.svg` (Stage 3) lets buyers pin a version.
   */
  async getHighestVersionActiveBadge(
    agentUrl: string,
    role: BadgeRole,
  ): Promise<AgentVerificationBadge | null> {
    // Numeric sort — see getBadgesForAgent comment.
    const result = await query(
      `SELECT * FROM agent_verification_badges
       WHERE agent_url = $1 AND role = $2 AND status IN ('active', 'degraded')
       ORDER BY split_part(adcp_version, '.', 1)::int DESC,
                split_part(adcp_version, '.', 2)::int DESC
       LIMIT 1`,
      [agentUrl, role],
    );
    return (result.rows[0] as AgentVerificationBadge) ?? null;
  }

  async revokeBadge(
    agentUrl: string,
    role: BadgeRole,
    adcpVersion: string,
    reason: string,
  ): Promise<void> {
    await query(
      `UPDATE agent_verification_badges
       SET status = 'revoked', revoked_at = NOW(), revocation_reason = $4, updated_at = NOW()
       WHERE agent_url = $1 AND role = $2 AND adcp_version = $3 AND status IN ('active', 'degraded')`,
      [agentUrl, role, adcpVersion, reason],
    );
  }

  async degradeBadge(
    agentUrl: string,
    role: BadgeRole,
    adcpVersion: string,
  ): Promise<void> {
    await query(
      `UPDATE agent_verification_badges
       SET status = 'degraded', updated_at = NOW()
       WHERE agent_url = $1 AND role = $2 AND adcp_version = $3 AND status = 'active'`,
      [agentUrl, role, adcpVersion],
    );
  }

  async bulkGetActiveBadges(agentUrls: string[]): Promise<Map<string, AgentVerificationBadge[]>> {
    if (agentUrls.length === 0) return new Map();
    // Numeric sort — see getBadgesForAgent comment.
    const result = await query(
      `SELECT * FROM agent_verification_badges
       WHERE agent_url = ANY($1) AND status IN ('active', 'degraded')
       ORDER BY agent_url,
                split_part(adcp_version, '.', 1)::int DESC,
                split_part(adcp_version, '.', 2)::int DESC,
                role`,
      [agentUrls],
    );
    const map = new Map<string, AgentVerificationBadge[]>();
    for (const row of result.rows) {
      const badges = map.get(row.agent_url) || [];
      badges.push(row as AgentVerificationBadge);
      map.set(row.agent_url, badges);
    }
    return map;
  }

  async getVerifiedAgentsByRole(role: BadgeRole): Promise<AgentVerificationBadge[]> {
    // Numeric sort — see getBadgesForAgent comment.
    const result = await query(
      `SELECT * FROM agent_verification_badges
       WHERE role = $1 AND status IN ('active', 'degraded')
       ORDER BY split_part(adcp_version, '.', 1)::int DESC,
                split_part(adcp_version, '.', 2)::int DESC,
                verified_at DESC`,
      [role],
    );
    return result.rows as AgentVerificationBadge[];
  }

  private computeStatus(overallRunStatus: OverallRunStatus): ComplianceStatus {
    switch (overallRunStatus) {
      case 'passing': return 'passing';
      case 'partial': return 'degraded';
      case 'failing': return 'failing';
      default: return 'unknown';
    }
  }
}

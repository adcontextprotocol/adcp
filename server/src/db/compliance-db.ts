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
export type TriggeredBy = 'heartbeat' | 'manual' | 'webhook';
export type TrackStatus = 'pass' | 'fail' | 'partial' | 'skip';

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

export interface ComplianceRun {
  id: string;
  agent_url: string;
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
  dry_run: boolean;
}

export interface TrackSummaryEntry {
  track: string;
  status: TrackStatus;
  scenario_count: number;
  passed_count: number;
  duration_ms: number;
}

export interface AgentComplianceStatus {
  agent_url: string;
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
}

export type StoryboardStatus = 'passing' | 'failing' | 'partial' | 'untested';
const VALID_STORYBOARD_STATUSES = new Set<StoryboardStatus>(['passing', 'failing', 'partial', 'untested']);

// Badge roles map to AdCP domains (see static/schemas/source/enums/adcp-domain.json).
export type BadgeRole = 'media-buy' | 'creative' | 'signals' | 'governance' | 'brand' | 'sponsored-intelligence';
export type BadgeStatus = 'active' | 'degraded' | 'revoked';

export interface AgentVerificationBadge {
  agent_url: string;
  role: BadgeRole;
  verified_at: Date;
  verified_protocol_version: string | null;
  verified_specialisms: string[];
  verification_token: string | null;
  token_expires_at: Date | null;
  membership_org_id: string | null;
  status: BadgeStatus;
  revoked_at: Date | null;
  revocation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StoryboardStatusEntry {
  storyboard_id: string;
  status: StoryboardStatus;
  steps_passed: number;
  steps_total: number;
}

export interface RecordComplianceRunInput {
  agent_url: string;
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
  dry_run?: boolean;
  storyboard_statuses?: StoryboardStatusEntry[];
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
          agent_url, lifecycle_stage, overall_status, headline,
          total_duration_ms, tracks_json, tracks_passed, tracks_failed,
          tracks_skipped, tracks_partial, agent_profile_json,
          observations_json, triggered_by, dry_run
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          input.agent_url,
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
          input.dry_run ?? true,
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
          tracks_summary_json, headline,
          previous_status, status_changed_at, updated_at
        ) VALUES (
          $1, $2, NOW(),
          CASE WHEN $2 = 'passing' THEN NOW() ELSE NULL END,
          CASE WHEN $2 IN ('failing', 'degraded') THEN NOW() ELSE NULL END,
          $3, $4,
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
          updated_at = NOW()
        RETURNING status, previous_status`,
        [
          input.agent_url,
          newStatus,
          JSON.stringify(tracksSummary),
          input.headline ?? null,
        ],
      );

      // 5. Batch upsert per-storyboard statuses (single query, not N+1)
      // Uses a SAVEPOINT so a missing table (pre-migration) doesn't roll back
      // the entire compliance run — the run and status update still commit.
      if (input.storyboard_statuses?.length) {
        // Validate status values before sending to Postgres to surface typos
        // as clear errors instead of cryptic constraint violations inside unnest
        for (const sb of input.storyboard_statuses) {
          if (!VALID_STORYBOARD_STATUSES.has(sb.status)) {
            throw new Error(`Invalid storyboard status "${sb.status}" for ${sb.storyboard_id}`);
          }
        }

        const sbIds = input.storyboard_statuses.map(s => s.storyboard_id);
        const sbStatuses = input.storyboard_statuses.map(s => s.status);
        const sbStepsPassed = input.storyboard_statuses.map(s => s.steps_passed);
        const sbStepsTotal = input.storyboard_statuses.map(s => s.steps_total);

        await client.query('SAVEPOINT storyboard_upsert');
        try {
          await client.query(
            `INSERT INTO agent_storyboard_status (
              agent_url, storyboard_id, status, last_tested_at,
              last_passed_at, last_failed_at, run_id,
              steps_passed, steps_total, triggered_by, updated_at
            )
            SELECT
              $1, sb_id, sb_status, NOW(),
              CASE WHEN sb_status = 'passing' THEN NOW() ELSE NULL END,
              CASE WHEN sb_status IN ('failing', 'partial') THEN NOW() ELSE NULL END,
              $4, sb_passed, sb_total, $7, NOW()
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
              updated_at = NOW()`,
            [input.agent_url, sbIds, sbStatuses, run.id, sbStepsPassed, sbStepsTotal, input.triggered_by ?? 'heartbeat'],
          );
          await client.query('RELEASE SAVEPOINT storyboard_upsert');
        } catch (sbErr) {
          await client.query('ROLLBACK TO SAVEPOINT storyboard_upsert');
          logger.warn({ err: sbErr, agentUrl: input.agent_url }, 'Storyboard status upsert failed (table may not exist yet)');
        }
      }

      await client.query('COMMIT');

      const row = statusResult.rows[0];
      const transition = row.previous_status && row.previous_status !== row.status
        ? { previous: row.previous_status as ComplianceStatus, current: row.status as ComplianceStatus }
        : null;

      return { run, statusTransition: transition, storyboardStatuses: input.storyboard_statuses ?? [] };
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
      `SELECT s.*, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       WHERE s.agent_url = $1`,
      [agentUrl],
    );
    return result.rows[0] || null;
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
      `SELECT s.*, COALESCE(m.lifecycle_stage, 'production') AS lifecycle_stage
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       WHERE s.agent_url = ANY($1)`,
      [agentUrls],
    );

    const map = new Map<string, AgentComplianceStatus>();
    for (const row of result.rows) {
      map.set(row.agent_url, row);
    }
    return map;
  }

  async getComplianceHistory(agentUrl: string, limit: number = 30): Promise<ComplianceRun[]> {
    const result = await query(
      `SELECT * FROM agent_compliance_runs
       WHERE agent_url = $1
       ORDER BY tested_at DESC
       LIMIT $2`,
      [agentUrl, limit],
    );
    return result.rows;
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
    const result = await query(
      `WITH known_agents AS (
        SELECT agent_url FROM discovered_agents
        UNION
        SELECT agent_url FROM agent_registry_metadata
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
      ORDER BY s.last_checked_at ASC NULLS FIRST
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

  // ----- Storyboard Status Queries -----

  async getStoryboardStatuses(agentUrl: string): Promise<Array<{
    storyboard_id: string;
    status: string;
    last_tested_at: Date | null;
    last_passed_at: Date | null;
    last_failed_at: Date | null;
    steps_passed: number;
    steps_total: number;
    triggered_by: string | null;
  }>> {
    const result = await query(
      `SELECT storyboard_id, status, last_tested_at, last_passed_at, last_failed_at,
              steps_passed, steps_total, triggered_by
       FROM agent_storyboard_status
       WHERE agent_url = $1
       ORDER BY storyboard_id`,
      [agentUrl],
    );
    return result.rows;
  }

  async getStoryboardStatusCounts(agentUrl: string): Promise<{ passing: number; total: number }> {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'passing') AS passing,
         COUNT(*) AS total
       FROM agent_storyboard_status
       WHERE agent_url = $1`,
      [agentUrl],
    );
    const row = result.rows[0];
    return { passing: parseInt(row?.passing ?? '0'), total: parseInt(row?.total ?? '0') };
  }

  async bulkGetStoryboardStatuses(agentUrls: string[]): Promise<Map<string, Array<{
    storyboard_id: string;
    status: string;
    last_tested_at: Date | null;
    last_passed_at: Date | null;
    steps_passed: number;
    steps_total: number;
  }>>> {
    if (agentUrls.length === 0) return new Map();

    const result = await query(
      `SELECT agent_url, storyboard_id, status, last_tested_at, last_passed_at,
              steps_passed, steps_total
       FROM agent_storyboard_status
       WHERE agent_url = ANY($1)
       ORDER BY agent_url, storyboard_id`,
      [agentUrls],
    );

    const map = new Map<string, Array<{
      storyboard_id: string; status: string;
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
   */
  async resolveOwnerAuth(
    agentUrl: string,
  ): Promise<{ type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | undefined> {
    try {
      const result = await query(
        `SELECT ac.organization_id,
                ac.auth_token_encrypted, ac.auth_token_iv, ac.auth_type,
                ac.oauth_access_token_encrypted, ac.oauth_access_token_iv,
                ac.oauth_token_expires_at
         FROM agent_contexts ac
         JOIN member_profiles mp
           ON mp.workos_organization_id = ac.organization_id
         WHERE ac.agent_url = $1
           AND mp.agents @> $2::jsonb
           AND (ac.auth_token_encrypted IS NOT NULL OR ac.oauth_access_token_encrypted IS NOT NULL)
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
          const decoded = Buffer.from(token, 'base64').toString();
          const colonIndex = decoded.indexOf(':');
          if (colonIndex >= 0) {
            return { type: 'basic', username: decoded.slice(0, colonIndex), password: decoded.slice(colonIndex + 1) };
          }
        }

        return { type: 'bearer', token };
      }

      // Fall back to OAuth access token
      if (row.oauth_access_token_encrypted && row.oauth_access_token_iv) {
        // Check expiration with 5-minute buffer
        if (row.oauth_token_expires_at) {
          const expiresAt = new Date(row.oauth_token_expires_at);
          if (expiresAt.getTime() - Date.now() <= 5 * 60 * 1000) {
            logger.debug({ agentUrl, expiresAt }, 'OAuth token expired or expiring soon for compliance auth');
            return undefined;
          }
        } else {
          logger.debug({ agentUrl }, 'OAuth token has no expiration recorded');
        }

        const token = decryptToken(row.oauth_access_token_encrypted, row.oauth_access_token_iv, row.organization_id);
        return { type: 'bearer', token };
      }

      return undefined;
    } catch (error) {
      logger.debug({ error, agentUrl }, 'Could not resolve owner auth for heartbeat');
      return undefined;
    }
  }

  // ----- Verification Badges -----

  async upsertBadge(badge: {
    agent_url: string;
    role: BadgeRole;
    verified_specialisms: string[];
    verified_protocol_version?: string;
    verification_token?: string;
    token_expires_at?: Date;
    membership_org_id?: string;
  }): Promise<AgentVerificationBadge> {
    const result = await query(
      `INSERT INTO agent_verification_badges (
        agent_url, role, verified_specialisms, verified_protocol_version,
        verification_token, token_expires_at, membership_org_id,
        status, verified_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
      ON CONFLICT (agent_url, role) DO UPDATE SET
        verified_specialisms = $3,
        verified_protocol_version = COALESCE($4, agent_verification_badges.verified_protocol_version),
        verification_token = COALESCE($5, agent_verification_badges.verification_token),
        token_expires_at = COALESCE($6, agent_verification_badges.token_expires_at),
        membership_org_id = COALESCE($7, agent_verification_badges.membership_org_id),
        status = 'active',
        verified_at = CASE WHEN agent_verification_badges.status = 'degraded' THEN NOW() ELSE agent_verification_badges.verified_at END,
        revoked_at = NULL,
        revocation_reason = NULL,
        updated_at = NOW()
      RETURNING *`,
      [
        badge.agent_url,
        badge.role,
        badge.verified_specialisms,
        badge.verified_protocol_version ?? null,
        badge.verification_token ?? null,
        badge.token_expires_at ?? null,
        badge.membership_org_id ?? null,
      ],
    );
    return result.rows[0] as AgentVerificationBadge;
  }

  async getBadgesForAgent(agentUrl: string): Promise<AgentVerificationBadge[]> {
    const result = await query(
      `SELECT * FROM agent_verification_badges WHERE agent_url = $1 AND status IN ('active', 'degraded')`,
      [agentUrl],
    );
    return result.rows as AgentVerificationBadge[];
  }

  async getActiveBadge(agentUrl: string, role: BadgeRole): Promise<AgentVerificationBadge | null> {
    const result = await query(
      `SELECT * FROM agent_verification_badges WHERE agent_url = $1 AND role = $2 AND status IN ('active', 'degraded')`,
      [agentUrl, role],
    );
    return (result.rows[0] as AgentVerificationBadge) ?? null;
  }

  async revokeBadge(agentUrl: string, role: BadgeRole, reason: string): Promise<void> {
    await query(
      `UPDATE agent_verification_badges
       SET status = 'revoked', revoked_at = NOW(), revocation_reason = $3, updated_at = NOW()
       WHERE agent_url = $1 AND role = $2 AND status IN ('active', 'degraded')`,
      [agentUrl, role, reason],
    );
  }

  async degradeBadge(agentUrl: string, role: BadgeRole): Promise<void> {
    await query(
      `UPDATE agent_verification_badges
       SET status = 'degraded', updated_at = NOW()
       WHERE agent_url = $1 AND role = $2 AND status = 'active'`,
      [agentUrl, role],
    );
  }

  async bulkGetActiveBadges(agentUrls: string[]): Promise<Map<string, AgentVerificationBadge[]>> {
    if (agentUrls.length === 0) return new Map();
    const result = await query(
      `SELECT * FROM agent_verification_badges WHERE agent_url = ANY($1) AND status IN ('active', 'degraded')`,
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
    const result = await query(
      `SELECT * FROM agent_verification_badges WHERE role = $1 AND status IN ('active', 'degraded') ORDER BY verified_at DESC`,
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

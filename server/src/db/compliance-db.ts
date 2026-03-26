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
export type TrackStatus = 'pass' | 'fail' | 'partial' | 'skip' | 'expected';

export interface AgentRegistryMetadata {
  agent_url: string;
  lifecycle_stage: LifecycleStage;
  compliance_opt_out: boolean;
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

  // ----- Compliance Runs -----

  /**
   * Record a compliance run and atomically update the materialized status.
   * Uses a transaction to ensure run and status are consistent.
   * Returns the status transition (previous -> current) for notification logic.
   */
  async recordComplianceRun(input: RecordComplianceRunInput): Promise<{
    run: ComplianceRun;
    statusTransition: { previous: ComplianceStatus; current: ComplianceStatus } | null;
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

      await client.query('COMMIT');

      const row = statusResult.rows[0];
      const transition = row.previous_status && row.previous_status !== row.status
        ? { previous: row.previous_status as ComplianceStatus, current: row.status as ComplianceStatus }
        : null;

      return { run, statusTransition: transition };
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
        AND (
          s.last_checked_at IS NULL
          OR (
            COALESCE(m.lifecycle_stage, 'production') = 'production'
            AND s.last_checked_at < NOW() - INTERVAL '12 hours'
          )
          OR (
            COALESCE(m.lifecycle_stage, 'production') = 'testing'
            AND s.last_checked_at < NOW() - INTERVAL '24 hours'
          )
        )
      ORDER BY s.last_checked_at ASC NULLS FIRST
      LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  // ----- Helpers -----

  /**
   * Resolve auth credentials for an agent URL from any organization's saved tokens.
   * Uses the most recently updated credential if multiple exist.
   */
  async resolveAuthForAgent(
    agentUrl: string,
  ): Promise<{ type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | undefined> {
    try {
      const result = await query(
        `SELECT organization_id, auth_token_encrypted, auth_token_iv, auth_type
         FROM agent_contexts
         WHERE agent_url = $1
           AND auth_token_encrypted IS NOT NULL
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [agentUrl],
      );

      const row = result.rows[0];
      if (!row) return undefined;

      const token = decryptToken(row.auth_token_encrypted, row.auth_token_iv, row.organization_id);

      if (row.auth_type === 'basic') {
        const decoded = Buffer.from(token, 'base64').toString();
        const colonIndex = decoded.indexOf(':');
        if (colonIndex >= 0) {
          return { type: 'basic', username: decoded.slice(0, colonIndex), password: decoded.slice(colonIndex + 1) };
        }
      }

      return { type: 'bearer', token };
    } catch (error) {
      logger.debug({ error, agentUrl }, 'Could not resolve auth for heartbeat');
      return undefined;
    }
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

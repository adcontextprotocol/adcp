/**
 * Admin agent management routes.
 *
 * Cross-org agent removal for rogue / disputed registrations. The member
 * surface at `DELETE /api/me/agents/:url` resolves the target org from the
 * caller's WorkOS membership, so admins (including the static
 * `admin_api_key` synthetic user) cannot use it to remove an entry that
 * lives in a different org's `member_profiles.agents` JSONB.
 *
 * This route deliberately bypasses the member-side "unpublish public
 * first" guard — the entries this endpoint exists to remove are typically
 * fraudulent and never had a real brand.json manifest behind them. The
 * caller must supply a `reason`, which lands in `registry_audit_log` so
 * every admin removal carries a written justification.
 */

import { Router } from 'express';
import { getPool } from '../../db/client.js';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { invalidateMemberContextCache } from '../../addie/index.js';
import type { AgentConfig } from '../../types.js';

const logger = createLogger('admin-agents');

const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

/**
 * Decode `member_profiles.agents`. The column is typed `jsonb` but the pg
 * driver hands it back as either an array or a JSON string depending on
 * driver settings. Any other shape (including a string that parses to a
 * non-array) means the column is corrupt — surface that to the caller
 * rather than silently coercing to `[]`, which would make a corrupted
 * profile look agent-less to the admin tool.
 */
class CorruptAgentsColumnError extends Error {
  constructor() {
    super('member_profiles.agents is not a JSON array');
    this.name = 'CorruptAgentsColumnError';
  }
}

function parseAgents(raw: unknown): AgentConfig[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw as AgentConfig[];
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CorruptAgentsColumnError();
    }
    if (parsed === null) return [];
    if (Array.isArray(parsed)) return parsed as AgentConfig[];
    throw new CorruptAgentsColumnError();
  }
  throw new CorruptAgentsColumnError();
}

export function setupAdminAgentsRoutes(apiRouter: Router): void {
  // GET /api/admin/accounts/:orgId/agents
  //
  // Lists the agents on an org's member profile. Companion to the DELETE
  // below — admins must be able to see what they're about to remove.
  apiRouter.get(
    '/accounts/:orgId/agents',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();
        const row = await pool.query<{ agents: unknown }>(
          `SELECT agents FROM member_profiles WHERE workos_organization_id = $1`,
          [orgId],
        );
        if (row.rowCount === 0) {
          return res.status(404).json({
            error: 'profile_not_found',
            message: `No member profile exists for org ${orgId}`,
          });
        }
        return res.json({ org_id: orgId, agents: parseAgents(row.rows[0].agents) });
      } catch (err) {
        if (err instanceof CorruptAgentsColumnError) {
          logger.error({ orgId }, 'member_profiles.agents column is corrupt');
          return res.status(500).json({
            error: 'corrupt_agents_column',
            message: `member_profiles.agents for org ${orgId} is not a JSON array`,
          });
        }
        logger.error({ err, orgId }, 'Admin agent list failed');
        return res.status(500).json({
          error: 'internal_error',
          message: 'Failed to list agents',
        });
      }
    },
  );

  // DELETE /api/admin/accounts/:orgId/agents/:url
  //
  // `:url` is URL-encoded by the caller (Express decodes path params once).
  // `reason` is required and lands in the audit trail; `escalation_id` is
  // optional context. Both arrive as query params — DELETE bodies are
  // poorly supported across HTTP clients.
  apiRouter.delete(
    '/accounts/:orgId/agents/:url',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;
      const targetUrl = req.params.url;

      const reasonParam = req.query.reason;
      const reason =
        typeof reasonParam === 'string' ? reasonParam.trim() : '';
      if (reason.length < MIN_REASON_LENGTH) {
        return res.status(400).json({
          error: 'reason_required',
          message: `reason query param is required (min ${MIN_REASON_LENGTH} chars)`,
        });
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return res.status(400).json({
          error: 'reason_too_long',
          message: `reason exceeds ${MAX_REASON_LENGTH} chars`,
        });
      }

      const escalationIdParam = req.query.escalation_id;
      const escalationId =
        typeof escalationIdParam === 'string' && escalationIdParam.length > 0
          ? escalationIdParam
          : null;

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const row = await client.query<{ id: string; agents: unknown }>(
          `SELECT id, agents
           FROM member_profiles
           WHERE workos_organization_id = $1
           FOR UPDATE`,
          [orgId],
        );
        if (row.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: 'profile_not_found',
            message: `No member profile exists for org ${orgId}`,
          });
        }

        const profileId = row.rows[0].id;
        const existing = parseAgents(row.rows[0].agents);
        const idx = existing.findIndex((a) => a.url === targetUrl);
        if (idx === -1) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: 'agent_not_found',
            message: `No agent with url=${targetUrl} on org ${orgId}`,
          });
        }

        const removed = existing[idx];
        const next = existing.filter((_, i) => i !== idx);

        await client.query(
          `UPDATE member_profiles
           SET agents = $1::jsonb, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(next), profileId],
        );

        await client.query(
          `INSERT INTO registry_audit_log
             (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'admin_remove_agent', 'agent', $3, $4)`,
          [
            orgId,
            req.user!.id,
            targetUrl,
            JSON.stringify({
              reason,
              escalation_id: escalationId,
              admin_email: req.user!.email,
              removed_agent: removed,
              bypassed_public_unpublish_guard: removed.visibility === 'public',
            }),
          ],
        );

        await client.query('COMMIT');

        // Addie's per-org member-context snapshot includes the agents
        // array; without this, her view stays stale until TTL.
        invalidateMemberContextCache();

        logger.warn(
          {
            orgId,
            agentUrl: targetUrl,
            adminUserId: req.user!.id,
            adminEmail: req.user!.email,
            escalationId,
            wasPublic: removed.visibility === 'public',
          },
          'Admin removed agent from org member profile',
        );

        // Public-visibility removals bypass the member-side
        // "unpublish first" guard, so any real brand.json manifest
        // for this org now points at a URL the registry no longer
        // recognizes. Unlike member-side unpublish
        // (member-profiles.ts:1485-1517, which calls
        // `brandDb.updateManifestAgents` first and only falls back
        // to a drift event on failure), the admin path deliberately
        // does NOT attempt reconciliation: the entries this endpoint
        // exists to remove are rogue registrations where the
        // owning-org-of-record is not a cooperating manifest owner,
        // so silently rewriting their brand-mirror is the wrong
        // default. Emit the structured drift event so `/check` picks
        // it up; ops can follow up with the rightful brand owner.
        if (removed.visibility === 'public') {
          logger.warn(
            {
              orgId,
              agentUrl: targetUrl,
              event: 'brand_json_drift',
              cause: 'admin_remove_agent',
              escalationId,
            },
            'Admin removed a public agent — brand.json manifest may now reference a stale URL; /check will surface drift',
          );
        }

        return res.json({
          removed_agent: removed,
          org_id: orgId,
          reason,
          escalation_id: escalationId,
          remaining_agent_count: next.length,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof CorruptAgentsColumnError) {
          logger.error({ orgId }, 'member_profiles.agents column is corrupt');
          return res.status(500).json({
            error: 'corrupt_agents_column',
            message: `member_profiles.agents for org ${orgId} is not a JSON array`,
          });
        }
        logger.error(
          { err, orgId, agentUrl: targetUrl },
          'Admin agent removal failed',
        );
        return res.status(500).json({
          error: 'internal_error',
          message: 'Failed to remove agent',
        });
      } finally {
        try {
          client.release();
        } catch (releaseErr) {
          logger.warn({ err: releaseErr, orgId }, 'pg client release failed');
        }
      }
    },
  );
}

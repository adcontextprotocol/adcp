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
import { canonicalizeAgentUrl } from '../../db/publisher-db.js';
import {
  hasApiAccess,
  OrganizationDatabase,
  resolveMembershipTier,
} from '../../db/organization-db.js';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { invalidateMemberContextCache } from '../../addie/index.js';
import {
  gateAgentVisibilityForCaller,
  type VisibilityWarning,
} from '../../services/agent-visibility-gate.js';
import {
  buildUnverifiedHostnameMessage,
  isHostnameOwnershipRejection,
  verifyAgentHostname,
} from '../../services/agent-hostname-verification.js';
import { logResolvedTypeChanges, resolveAgentTypes } from '../member-profiles.js';
import type { AgentConfig } from '../../types.js';
import { isValidAgentType, isValidAgentVisibility } from '../../types.js';

const logger = createLogger('admin-agents');
const orgDb = new OrganizationDatabase();

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

function isParseableUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function pickAgent(agents: AgentConfig[], url: string): AgentConfig | undefined {
  return agents.find((a) => a.url === url);
}

function redactAgentForAudit<T extends { health_check_url?: string } | undefined>(agent: T): T {
  if (!agent?.health_check_url) return agent;
  try {
    const url = new URL(agent.health_check_url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { ...agent, health_check_url: url.toString() };
  } catch {
    return { ...agent, health_check_url: '[redacted-invalid-url]' };
  }
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

  // POST /api/admin/accounts/:orgId/agents
  //
  // Audited repair path for registering or updating a single agent under an
  // existing member profile. Mirrors the member POST's identity protections:
  // canonical URL matching, declared type requirement, hostname ownership
  // verification, visibility gating, type-resolution smuggle protection, and
  // metadata seeding.
  apiRouter.post(
    '/accounts/:orgId/agents',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const { orgId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;

      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < MIN_REASON_LENGTH) {
        return res.status(400).json({
          error: 'reason_required',
          message: `reason is required in the request body (min ${MIN_REASON_LENGTH} chars)`,
        });
      }
      if (reason.length > MAX_REASON_LENGTH) {
        return res.status(400).json({
          error: 'reason_too_long',
          message: `reason exceeds ${MAX_REASON_LENGTH} chars`,
        });
      }

      const rawUrl = typeof body.url === 'string' ? body.url : '';
      if (rawUrl.length === 0) {
        return res.status(400).json({ error: 'url_required', message: 'url is required' });
      }
      if (!isParseableUrl(rawUrl)) {
        return res.status(400).json({ error: 'invalid_url', message: 'url must be a valid URL' });
      }
      if (rawUrl.includes('?') || rawUrl.includes('#')) {
        return res.status(400).json({
          error: 'invalid_url',
          message: 'url must not contain query strings or fragments',
        });
      }
      const canonicalUrl = canonicalizeAgentUrl(rawUrl);
      if (!canonicalUrl) {
        return res.status(400).json({ error: 'invalid_url', message: 'url is not a valid agent URL' });
      }

      const type = body.type;
      if (typeof type !== 'string' || !isValidAgentType(type) || type === 'unknown') {
        return res.status(400).json({
          error: 'type_required',
          message: 'Specify one of: brand, rights, measurement, governance, creative, sales, buying, signals.',
        });
      }

      const requestedVisibility = body.visibility;
      if (requestedVisibility !== undefined && !isValidAgentVisibility(requestedVisibility)) {
        return res.status(400).json({
          error: 'invalid_visibility',
          message: 'visibility must be one of: private, members_only, public.',
        });
      }
      if (requestedVisibility === 'public') {
        return res.status(400).json({
          error: 'public_visibility_not_supported',
          message: 'Admin agent repair can register private or members_only agents only. Use the normal publish flow to list an agent publicly.',
        });
      }

      const verification = await verifyAgentHostname(orgId, canonicalUrl);
      if (isHostnameOwnershipRejection(verification)) {
        return res.status(400).json({
          error: 'unverified_hostname',
          message: buildUnverifiedHostnameMessage(verification),
          agent_hostname: verification.agent_hostname,
          verified_domains: verification.verified_domains,
          reason: verification.reason,
        });
      }

      const escalationId =
        typeof body.escalation_id === 'string' && body.escalation_id.length > 0
          ? body.escalation_id
          : null;
      const agentPatch: Partial<AgentConfig> & { url: string } = {
        url: canonicalUrl,
        type,
        ...(requestedVisibility !== undefined ? { visibility: requestedVisibility } : {}),
        ...(typeof body.name === 'string' && body.name.trim().length > 0
          ? { name: body.name.trim() }
          : {}),
        ...(typeof body.health_check_url === 'string' && body.health_check_url.length > 0
          ? { health_check_url: body.health_check_url }
          : {}),
      };

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
        const idx = existing.findIndex((a) => (canonicalizeAgentUrl(a.url) ?? a.url) === canonicalUrl);
        const wasUpdate = idx !== -1;
        const newAgent: AgentConfig = {
          ...agentPatch,
          visibility: requestedVisibility ?? 'members_only',
        } as AgentConfig;
        const next = wasUpdate
          ? existing.map((a, i) => (i === idx ? { ...a, ...agentPatch } : a))
          : [...existing, newAgent];

        const org = await orgDb.getOrganization(orgId);
        const callerHasApi = hasApiAccess(resolveMembershipTier(org));
        const { agents: gated, warnings } = gateAgentVisibilityForCaller(next, callerHasApi);
        const typed = (await resolveAgentTypes(gated)) as AgentConfig[];
        await logResolvedTypeChanges(gated, typed, orgId);

        await client.query(
          `UPDATE member_profiles
           SET agents = $1::jsonb, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(typed), profileId],
        );

        const urls = typed
          .map((a) => (a && typeof a.url === 'string' ? canonicalizeAgentUrl(a.url) : null))
          .filter((u): u is string => u !== null);
        if (urls.length > 0) {
          await client.query(
            `INSERT INTO agent_registry_metadata (agent_url)
             SELECT unnest($1::text[])
             ON CONFLICT (agent_url) DO NOTHING`,
            [urls],
          );
        }

        const upsertedAgent = pickAgent(typed, canonicalUrl);
        await client.query(
          `INSERT INTO registry_audit_log
             (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, 'admin_add_agent', 'agent', $3, $4)`,
          [
            orgId,
            req.user!.id,
            canonicalUrl,
            JSON.stringify({
              reason,
              escalation_id: escalationId,
              admin_email: req.user!.email,
              was_update: wasUpdate,
              requested_agent: redactAgentForAudit(wasUpdate ? agentPatch : newAgent),
              upserted_agent: redactAgentForAudit(upsertedAgent),
            }),
          ],
        );

        await client.query('COMMIT');
        invalidateMemberContextCache();

        logger.warn(
          {
            orgId,
            agentUrl: canonicalUrl,
            adminUserId: req.user!.id,
            adminEmail: req.user!.email,
            escalationId,
            wasUpdate,
          },
          'Admin registered agent on org member profile',
        );

        return res.status(wasUpdate ? 200 : 201).json({
          agent: upsertedAgent,
          org_id: orgId,
          reason,
          escalation_id: escalationId,
          was_update: wasUpdate,
          agents_count: typed.length,
          ...(warnings.length ? { warnings: warnings as VisibilityWarning[] } : {}),
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
        logger.error({ err, orgId, agentUrl: canonicalUrl }, 'Admin agent registration failed');
        return res.status(500).json({
          error: 'internal_error',
          message: 'Failed to register agent',
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

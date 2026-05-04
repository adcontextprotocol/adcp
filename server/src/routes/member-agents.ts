/**
 * Per-agent REST surface mounted at /api/me/agents.
 *
 * Lets members register, list, update, and remove individual agents
 * without round-tripping the full profile via PUT /api/me/member-profile.
 * Reuses the same visibility gate, server-side type resolution, and
 * audit log as the bulk-profile path so callers cannot smuggle past
 * the tier check.
 *
 * Auth: WorkOS session OR Bearer API key (`requireAuth` handles both).
 *
 * Concurrency: writes go through a `SELECT … FOR UPDATE` on
 * `member_profiles` so two parallel POSTs/PATCHes/DELETEs serialize
 * cleanly instead of racing on the JSONB read-modify-write the bulk
 * PUT path uses.
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { brandCreationRateLimiter } from '../middleware/rate-limit.js';
import { MemberDatabase } from '../db/member-db.js';
import {
  OrganizationDatabase,
  hasApiAccess,
  resolveMembershipTier,
} from '../db/organization-db.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { getPool } from '../db/client.js';
import type { AgentConfig } from '../types.js';
import { resolveAgentTypes, logResolvedTypeChanges } from './member-profiles.js';
import {
  gateAgentVisibilityForCaller,
  type VisibilityWarning,
} from '../services/agent-visibility-gate.js';
// Side-effect import: registers OpenAPI paths + component schemas for these
// routes. Lives in schemas/ to keep the spec generator's import graph free of
// auth middleware (WorkOS init at module load).
import '../schemas/member-agents-openapi.js';

const logger = createLogger('member-agents-routes');

export interface MemberAgentsRouterConfig {
  memberDb: MemberDatabase;
  orgDb: OrganizationDatabase;
  invalidateMemberContextCache: () => void;
}

/**
 * Decoded shape of `member_profiles.agents` JSONB. The column is JSONB but
 * pg sometimes hands it back as a string depending on driver settings.
 */
function parseAgents(raw: unknown): AgentConfig[] {
  if (Array.isArray(raw)) return raw as AgentConfig[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AgentConfig[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type RouteResult =
  | { kind: 'reject'; status: number; body: Record<string, unknown> }
  | { kind: 'commit'; next: AgentConfig[]; status: number; meta?: Record<string, unknown> };

export function createMemberAgentsRouter(config: MemberAgentsRouterConfig): Router {
  const { orgDb, invalidateMemberContextCache } = config;
  const router = Router();

  async function resolveOrgOrSendError(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<string | null> {
    const orgId = await resolvePrimaryOrganization(req.user!.id);
    if (!orgId) {
      res.status(400).json({ error: 'No organization associated with this account' });
      return null;
    }
    return orgId;
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

  /**
   * Run a single-agent mutation under `SELECT … FOR UPDATE` on the org's
   * member_profiles row. The mutator decides what `next` should look like
   * given the locked `existing` array, or short-circuits with a `reject`
   * to send a 4xx without writing.
   *
   * The gate (`gateAgentVisibilityForCaller`) and `resolveAgentTypes` are
   * applied here, not in the route handler — this is the only path that
   * writes the JSONB, so smuggle-protection lives here exactly once.
   */
  async function applyMemberAgentMutation(
    orgId: string,
    mutate: (existing: AgentConfig[]) => RouteResult | Promise<RouteResult>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(
        `SELECT id, agents
         FROM member_profiles
         WHERE workos_organization_id = $1
         FOR UPDATE`,
        [orgId],
      );
      if (row.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          status: 404,
          body: {
            error: 'Profile not found',
            message: 'Create a member profile via POST /api/me/member-profile first.',
          },
        };
      }

      const profileId = row.rows[0].id as string;
      const existing = parseAgents(row.rows[0].agents);
      const result = await mutate(existing);
      if (result.kind === 'reject') {
        await client.query('ROLLBACK');
        return { status: result.status, body: result.body };
      }

      const org = await orgDb.getOrganization(orgId);
      const callerHasApi = hasApiAccess(resolveMembershipTier(org));
      const { agents: gated, warnings } = gateAgentVisibilityForCaller(result.next, callerHasApi);
      const typed = (await resolveAgentTypes(gated)) as AgentConfig[];
      await logResolvedTypeChanges(gated, typed, orgId);

      await client.query(
        `UPDATE member_profiles
         SET agents = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(typed), profileId],
      );
      await client.query('COMMIT');
      invalidateMemberContextCache();

      const body: Record<string, unknown> = {
        ...(result.meta ?? {}),
        agents: typed,
        ...(warnings.length ? { warnings } : {}),
      };
      return { status: result.status, body };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      try {
        client.release();
      } catch (releaseErr) {
        logger.warn({ err: releaseErr, orgId }, 'pg client release failed');
      }
    }
  }

  function pickAgent(body: Record<string, unknown>, url: string): AgentConfig | undefined {
    const agents = body.agents;
    if (!Array.isArray(agents)) return undefined;
    return (agents as AgentConfig[]).find((a) => a.url === url);
  }

  function shapeWriteBody(
    raw: Record<string, unknown> | null,
    url: string,
  ): Record<string, unknown> {
    if (!raw) return {};
    const agent = pickAgent(raw, url);
    const warnings = raw.warnings as VisibilityWarning[] | undefined;
    return {
      agent,
      ...(warnings && warnings.length ? { warnings } : {}),
    };
  }

  // GET /api/me/agents — list this org's registered agents
  router.get('/', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveOrgOrSendError(req, res);
      if (!orgId) return;

      const profile = await config.memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: 'Create a member profile via POST /api/me/member-profile first.',
        });
      }
      return res.json({ agents: profile.agents || [] });
    } catch (err) {
      logger.error({ err }, 'GET /api/me/agents failed');
      return res.status(500).json({ error: 'Failed to list agents' });
    }
  });

  // POST /api/me/agents — register or update a single agent (idempotent on url)
  router.post('/', requireAuth, brandCreationRateLimiter, async (req, res) => {
    try {
      const orgId = await resolveOrgOrSendError(req, res);
      if (!orgId) return;

      const body = (req.body ?? {}) as Partial<AgentConfig>;
      if (typeof body.url !== 'string' || body.url.length === 0) {
        return res.status(400).json({ error: 'url is required' });
      }
      if (!isParseableUrl(body.url)) {
        return res.status(400).json({ error: 'url must be a valid URL' });
      }
      const targetUrl = body.url;

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        const idx = existing.findIndex((a) => a.url === targetUrl);
        const isUpdate = idx !== -1;
        const next = isUpdate
          ? existing.map((a, i) => (i === idx ? { ...a, ...body } : a))
          : [...existing, body as AgentConfig];
        return {
          kind: 'commit' as const,
          next,
          status: isUpdate ? 200 : 201,
        };
      });
      return res.status(result.status).json(shapeWriteBody(result.body, targetUrl));
    } catch (err) {
      logger.error({ err }, 'POST /api/me/agents failed');
      return res.status(500).json({ error: 'Failed to register agent' });
    }
  });

  // PATCH /api/me/agents/:url — update a single entry by url-encoded URL
  router.patch('/:url', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveOrgOrSendError(req, res);
      if (!orgId) return;

      // Express already URL-decodes path params; do not double-decode.
      const targetUrl = req.params.url;
      const patch = (req.body ?? {}) as Partial<AgentConfig>;

      // Refuse to silently drop a `url` rename. Tell the caller; never guess.
      if (typeof patch.url === 'string' && patch.url !== targetUrl) {
        return res.status(400).json({
          error: 'url_immutable',
          message:
            'url cannot be changed via PATCH. DELETE the old entry and POST the new url.',
        });
      }

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        const idx = existing.findIndex((a) => a.url === targetUrl);
        if (idx === -1) {
          return {
            kind: 'reject' as const,
            status: 404,
            body: { error: 'Agent not found' },
          };
        }
        const next = existing.map((a, i) =>
          i === idx ? { ...a, ...patch, url: a.url } : a,
        );
        return { kind: 'commit' as const, next, status: 200 };
      });
      return res.status(result.status).json(shapeWriteBody(result.body, targetUrl));
    } catch (err) {
      logger.error({ err }, 'PATCH /api/me/agents/:url failed');
      return res.status(500).json({ error: 'Failed to update agent' });
    }
  });

  // DELETE /api/me/agents/:url — remove a single entry by url-encoded URL
  router.delete('/:url', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveOrgOrSendError(req, res);
      if (!orgId) return;

      // Express already URL-decodes path params; do not double-decode.
      const targetUrl = req.params.url;

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        const idx = existing.findIndex((a) => a.url === targetUrl);
        if (idx === -1) {
          return {
            kind: 'reject' as const,
            status: 404,
            body: { error: 'Agent not found' },
          };
        }
        // A `public` agent is reflected in `brand.json`. Refuse to delete
        // here so the JSONB and the manifest can never silently disagree —
        // unpublish (PATCH visibility=private OR DELETE
        // /api/me/member-profile/agents/:index/publish) reconciles the
        // manifest first via applyAgentVisibility's brand.json codepath.
        if (existing[idx].visibility === 'public') {
          return {
            kind: 'reject' as const,
            status: 409,
            body: {
              error: 'unpublish_first',
              message:
                'Agent is currently public and is reflected in brand.json. PATCH /api/me/agents/{url} with `visibility: "private"` (or call DELETE /api/me/member-profile/agents/{index}/publish) before deleting.',
              agent_url: targetUrl,
            },
          };
        }
        return {
          kind: 'commit' as const,
          next: existing.filter((a) => a.url !== targetUrl),
          status: 204,
        };
      });
      if (result.status === 204) return res.status(204).send();
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err }, 'DELETE /api/me/agents/:url failed');
      return res.status(500).json({ error: 'Failed to delete agent' });
    }
  });

  return router;
}

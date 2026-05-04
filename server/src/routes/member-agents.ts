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
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { MemberDatabase } from '../db/member-db.js';
import {
  OrganizationDatabase,
  hasApiAccess,
  resolveMembershipTier,
} from '../db/organization-db.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import type { AgentConfig } from '../types.js';
import { resolveAgentTypes, logResolvedTypeChanges } from './member-profiles.js';
import { gateAgentVisibilityForCaller } from '../services/agent-visibility-gate.js';
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

export function createMemberAgentsRouter(config: MemberAgentsRouterConfig): Router {
  const { memberDb, orgDb, invalidateMemberContextCache } = config;
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

  // GET /api/me/agents — list this org's registered agents
  router.get('/', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveOrgOrSendError(req, res);
      if (!orgId) return;

      const profile = await memberDb.getProfileByOrgId(orgId);
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
  router.post('/', requireAuth, async (req, res) => {
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

      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: 'Create a member profile via POST /api/me/member-profile first.',
        });
      }

      const existing = profile.agents || [];
      const idx = existing.findIndex((a) => a.url === body.url);
      const isUpdate = idx !== -1;
      const merged = isUpdate
        ? existing.map((a, i) => (i === idx ? { ...a, ...body } : a))
        : [...existing, body as AgentConfig];

      const org = await orgDb.getOrganization(orgId);
      const callerHasApi = hasApiAccess(resolveMembershipTier(org));
      const { agents: gated, warnings } = gateAgentVisibilityForCaller(merged, callerHasApi);
      const typed = (await resolveAgentTypes(gated)) as AgentConfig[];
      await logResolvedTypeChanges(gated, typed, orgId);

      const updated = await memberDb.updateProfileByOrgId(orgId, { agents: typed });
      invalidateMemberContextCache();

      const agent = (updated?.agents || []).find((a) => a.url === body.url);
      return res.status(isUpdate ? 200 : 201).json({
        agent,
        ...(warnings.length ? { warnings } : {}),
      });
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
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      const existing = profile.agents || [];
      const idx = existing.findIndex((a) => a.url === targetUrl);
      if (idx === -1) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const patch = (req.body ?? {}) as Partial<AgentConfig>;
      // url is the addressable identifier; ignore attempts to change it via PATCH.
      const merged = existing.map((a, i) =>
        i === idx ? { ...a, ...patch, url: a.url } : a,
      );

      const org = await orgDb.getOrganization(orgId);
      const callerHasApi = hasApiAccess(resolveMembershipTier(org));
      const { agents: gated, warnings } = gateAgentVisibilityForCaller(merged, callerHasApi);
      const typed = (await resolveAgentTypes(gated)) as AgentConfig[];
      await logResolvedTypeChanges(gated, typed, orgId);

      const updated = await memberDb.updateProfileByOrgId(orgId, { agents: typed });
      invalidateMemberContextCache();

      const agent = (updated?.agents || []).find((a) => a.url === targetUrl);
      return res.json({
        agent,
        ...(warnings.length ? { warnings } : {}),
      });
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
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      const existing = profile.agents || [];
      if (!existing.some((a) => a.url === targetUrl)) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const next = existing.filter((a) => a.url !== targetUrl);
      await memberDb.updateProfileByOrgId(orgId, { agents: next });
      invalidateMemberContextCache();
      return res.status(204).send();
    } catch (err) {
      logger.error({ err }, 'DELETE /api/me/agents/:url failed');
      return res.status(500).json({ error: 'Failed to delete agent' });
    }
  });

  return router;
}

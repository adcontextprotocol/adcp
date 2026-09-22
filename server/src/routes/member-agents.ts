/**
 * Per-agent REST surface mounted at /api/me/agents.
 *
 * Lets members register, list, update, and remove individual agents
 * without round-tripping the full profile via PUT /api/me/member-profile.
 * Reuses the same visibility gate and server-side type resolution as
 * the bulk-profile path so callers cannot smuggle past the tier check.
 * Type-resolution flips (the smuggle-protection events themselves) are
 * audit-logged; pure renames and deletes are not — same scope as the
 * bulk PUT path.
 *
 * Auth: WorkOS session OR Bearer API key (`requireAuth` handles both).
 * Human callers must pass `?org=…` to select an existing organization;
 * a validated WorkOS API key uses its provider-bound organization directly.
 * Neither path creates an organization.
 *
 * Concurrency: writes go through a `SELECT … FOR UPDATE` on
 * `member_profiles` so two parallel POSTs/PATCHes/DELETEs serialize
 * cleanly instead of racing on the JSONB read-modify-write the bulk
 * PUT path uses.
 */

import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth, type ValidatedApiKey } from '../middleware/auth.js';
import { brandCreationRateLimiter } from '../middleware/rate-limit.js';
import { MemberDatabase } from '../db/member-db.js';
import {
  OrganizationDatabase,
  hasApiAccess,
  resolveMembershipTier,
} from '../db/organization-db.js';
import { getOrganizationAuthorizationUserId } from '../auth/organization-principal.js';
import { getPool } from '../db/client.js';
import { canonicalizeAgentUrl } from '../db/publisher-db.js';
import type { AgentConfig } from '../types.js';
import { isValidAgentType } from '../types.js';
import { resolveAgentTypes, logResolvedTypeChanges } from './member-profiles.js';
import { ensureMemberProfileExists } from '../services/member-profile-autopublish.js';
import { validateExternalUrl } from '../utils/url-security.js';
import {
  gateAgentVisibilityForCaller,
  type VisibilityWarning,
} from '../services/agent-visibility-gate.js';
import {
  verifyAgentHostname,
  buildUnverifiedHostnameMessage,
  isHostnameOwnershipRejection,
} from '../services/agent-hostname-verification.js';
// Side-effect import: registers OpenAPI paths + component schemas for these
// routes. Lives in schemas/ to keep the spec generator's import graph free of
// auth middleware (WorkOS init at module load).
import '../schemas/member-agents-openapi.js';

const logger = createLogger('member-agents-routes');

export interface MemberAgentsRouterConfig {
  memberDb: MemberDatabase;
  orgDb: OrganizationDatabase;
  /**
   * WorkOS client. Required when callers may pass `?org=` to target a
   * non-primary organization; verification of membership against that org
   * goes through WorkOS. Pass `null` only in dev/test where the resolver
   * can short-circuit on the local memberships cache.
   */
  workos: WorkOS | null;
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
  const { orgDb, workos, invalidateMemberContextCache } = config;
  const router = Router();

  /** Select one explicit organization and resolve only direct WorkOS authority. */
  async function resolveOrgOrSendError(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<string | null> {
    const requestedOrgId = typeof req.query.org === 'string' ? req.query.org : null;
    const apiKey = (req as typeof req & { apiKey?: ValidatedApiKey }).apiKey;
    if (apiKey) {
      if (requestedOrgId && requestedOrgId !== apiKey.organizationId) {
        res.status(403).json({
          error: 'organization_selection_conflict',
          message: 'The requested organization does not match this API key.',
        });
        return null;
      }
      const localOrganization = await orgDb.getOrganization(apiKey.organizationId);
      if (!localOrganization) {
        res.status(409).json({
          error: 'api_key_organization_not_provisioned',
          message: 'This API key has a WorkOS organization, but that organization is not provisioned in the registry. Contact support to reconcile the existing organization; do not create another one.',
        });
        return null;
      }
      return apiKey.organizationId;
    }
    if (!requestedOrgId) {
      res.status(400).json({ error: 'An explicit ?org= is required' });
      return null;
    }
    if (!workos) {
      res.status(503).json({ error: 'Organization membership temporarily unavailable' });
      return null;
    }
    const userId = getOrganizationAuthorizationUserId(req.user!);
    try {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId, organizationId: requestedOrgId, statuses: ['active'],
      });
      const matching = memberships.data.filter(m => m.userId === userId
        && m.organizationId === requestedOrgId && m.status === 'active');
      if (matching.length !== 1 || !['member', 'admin', 'owner'].includes(matching[0].role?.slug ?? '')) {
        res.status(403).json({ error: 'Not authorized for the requested organization' });
        return null;
      }
      return requestedOrgId;
    } catch (err) {
      logger.warn({ err }, 'Exact WorkOS membership lookup unavailable');
      res.status(503).json({ error: 'Organization membership temporarily unavailable' });
      return null;
    }
  }

  /** Explicit organization selection is required; agent writes cannot onboard. */
  async function resolveExplicitRegistrationOrg(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<{ orgId: string; orgAutoCreated: boolean } | null> {
    const apiKey = (req as typeof req & { apiKey?: ValidatedApiKey }).apiKey;
    if (!apiKey && (typeof req.query.org !== 'string' || !req.query.org)) {
      res.status(403).json({
        error: 'organization_onboarding_disabled',
        message: 'Select an existing organization explicitly with ?org= to register an agent.',
      });
      return null;
    }
    const orgId = await resolveOrgOrSendError(req, res);
    return orgId ? { orgId, orgAutoCreated: false } : null;
  }

  type AgentRegistrationValidation =
    | {
        ok: true;
        body: Partial<AgentConfig>;
        targetUrl: string;
      }
    | {
        ok: false;
        error: Record<string, unknown>;
      };

  function validateAgentRegistrationBody(raw: unknown): AgentRegistrationValidation {
    const candidate = (raw ?? {}) as Partial<AgentConfig>;
    if (typeof candidate.url !== 'string' || candidate.url.length === 0) {
      return { ok: false, error: { error: 'url is required' } };
    }
    if (!validateExternalUrl(candidate.url)) {
      return { ok: false, error: { error: 'url must be a valid http or https URL' } };
    }
    const parsedUrl = new URL(candidate.url);
    if (parsedUrl.username || parsedUrl.password) {
      return { ok: false, error: { error: 'url must not contain credentials' } };
    }
    if (candidate.url.includes('?') || candidate.url.includes('#')) {
      return {
        ok: false,
        error: { error: 'url must not contain query strings or fragments' },
      };
    }

    const canonicalUrl = canonicalizeAgentUrl(candidate.url);
    if (!canonicalUrl) {
      return { ok: false, error: { error: 'url is not a valid agent URL' } };
    }
    if (
      typeof candidate.type !== 'string' ||
      !isValidAgentType(candidate.type) ||
      candidate.type === 'unknown'
    ) {
      return {
        ok: false,
        error: {
          error: 'type is required',
          message:
            'Specify one of: brand, rights, measurement, governance, creative, sales, buying, signals.',
        },
      };
    }

    return {
      ok: true,
      body: { ...candidate, url: canonicalUrl },
      targetUrl: canonicalUrl,
    };
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

      // Stage 2 of #4159 dropped the primary_brand_domain column; this
      // path no longer auto-backfills brand-primary from agent URL
      // hostnames. The canonical brand-primary lives on
      // organization_domains.is_primary, set via the Linked Domains UI
      // (PR #4179) or the WorkOS verify-domain auto-promote.
      await client.query(
        `UPDATE member_profiles
         SET agents = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(typed), profileId],
      );

      // Ensure every registered agent has an `agent_registry_metadata` row
      // so the compliance heartbeat picks it up. Pre-fix, the heartbeat's
      // `known_agents` CTE unioned only `discovered_agents` and
      // `agent_registry_metadata` — agents living solely in
      // `member_profiles.agents` JSONB stayed `unknown` forever, regardless
      // of the 12h cycle. The read-side CTE was widened in the same change
      // so existing rows recover, but writing the row here keeps every
      // downstream consumer of `agent_registry_metadata` (lifecycle,
      // monitoring, rate-limit policy) consistent without needing each one
      // to learn about the JSONB shape.
      //
      // Atomic with the JSONB write — same transaction, same FOR UPDATE
      // lock. ON CONFLICT DO NOTHING preserves any owner-customized
      // lifecycle_stage / check_interval_hours / opt-out the heartbeat or
      // dashboard wrote earlier; we only seed the row when it doesn't
      // exist. Defaults inherit from the column DDL.
      // Canonicalize before seeding the metadata table. Handlers above
      // already canonicalize, but this keeps any future write site honest
      // and matches the canonical-form invariant the rest of the registry
      // relies on (issue #3573).
      const urls = typed
        .map(a => (a && typeof a.url === 'string' ? canonicalizeAgentUrl(a.url) : null))
        .filter((u): u is string => u !== null);
      if (urls.length > 0) {
        await client.query(
          `INSERT INTO agent_registry_metadata (agent_url)
           SELECT unnest($1::text[])
           ON CONFLICT (agent_url) DO NOTHING`,
          [urls],
        );
      }

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
      const resolved = await resolveExplicitRegistrationOrg(req, res);
      if (!resolved) return;
      const { orgId, orgAutoCreated } = resolved;

      const validation = validateAgentRegistrationBody(req.body);
      if (!validation.ok) return res.status(400).json(validation.error);
      const { body, targetUrl } = validation;
      // Hostname ownership check (#4499 MVP). Catches the escalation-#340
      // failure mode: org has staked a domain claim (`organization_domains`
      // row with `verified = true`) but is now registering an agent on a
      // DIFFERENT domain. Adzymic registering `celtra.com` is the canonical
      // case. Orgs with zero verified domains (e.g. personal workspaces on
      // free email providers) pass through — they have no claim to enforce
      // against. Existing entries are grandfathered; only new POSTs go
      // through this gate. Adagents.json delegation and DNS challenge paths
      // for legitimate cross-domain registration come in later phases of
      // #4499.
      const verification = await verifyAgentHostname(orgId, targetUrl);
      if (isHostnameOwnershipRejection(verification)) {
        return res.status(400).json({
          error: 'unverified_hostname',
          message: buildUnverifiedHostnameMessage(verification),
          agent_hostname: verification.agent_hostname,
          verified_domains: verification.verified_domains,
          reason: verification.reason,
        });
      }

      // Auto-bootstrap a private member profile if the caller's org doesn't
      // have one yet. Reuses `ensureMemberProfileExists` (the same helper
      // Addie's `save_agent` tool uses) so slug-collision handling and the
      // private-by-default invariant stay consistent across surfaces.
      let profileAutoCreated = false;
      try {
        const org = await config.orgDb.getOrganization(orgId);
        const orgName = org?.name?.trim();
        if (orgName) {
          const ensured = await ensureMemberProfileExists({
            orgId,
            orgName,
            source: 'rest_agent_register',
          });
          profileAutoCreated = ensured.created;
        }
      } catch (err) {
        // Fall through to the mutation helper's existing 404 if bootstrap
        // fails — preserves the prior "create profile first" message
        // rather than masking the failure.
        logger.warn({ err, orgId }, 'POST /api/me/agents profile auto-bootstrap failed; falling through');
      }

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        // Match existing rows in canonical form so a legacy non-canonical
        // entry (pre-#3573) gets upgraded in place rather than duplicated.
        const idx = existing.findIndex((a) => (canonicalizeAgentUrl(a.url) ?? a.url) === targetUrl);
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
      const shaped = shapeWriteBody(result.body, targetUrl);
      if (result.status >= 200 && result.status < 300) {
        if (orgAutoCreated) shaped.org_auto_created = true;
        if (profileAutoCreated) shaped.profile_auto_created = true;
      }
      return res.status(result.status).json(shaped);
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
      // Canonicalize so a member submitting `HTTPS://Example.com/` matches
      // the row stored canonically (issue #3573).
      const targetUrl = canonicalizeAgentUrl(req.params.url);
      if (!targetUrl) {
        return res.status(400).json({ error: 'url is not a valid agent URL' });
      }
      const patch = (req.body ?? {}) as Partial<AgentConfig>;

      // Refuse to silently drop a `url` rename. Tell the caller; never guess.
      // Compare in canonical form so `https://Example.com/` in the path and
      // `https://example.com` in the body aren't flagged as a rename.
      if (typeof patch.url === 'string') {
        const patchCanonical = canonicalizeAgentUrl(patch.url);
        if (patchCanonical !== targetUrl) {
          return res.status(400).json({
            error: 'url_immutable',
            message:
              'url cannot be changed via PATCH. DELETE the old entry and POST the new url.',
          });
        }
      }
      // If `type` is being patched, it must be a valid declared type. 'unknown'
      // is server-side-only. Omitting `type` from the patch is fine — the
      // caller is updating other fields and leaving the existing type alone.
      if (patch.type !== undefined) {
        if (typeof patch.type !== 'string' || !isValidAgentType(patch.type) || patch.type === 'unknown') {
          return res.status(400).json({
            error: 'invalid_type',
            message: 'type must be one of: brand, rights, measurement, governance, creative, sales, buying, signals.',
          });
        }
      }

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        // Canonical-form match so a legacy non-canonical row is still found.
        const idx = existing.findIndex((a) => (canonicalizeAgentUrl(a.url) ?? a.url) === targetUrl);
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
      // Canonicalize so non-canonical url-encoded paths still match the
      // canonical row stored on disk (issue #3573).
      const targetUrl = canonicalizeAgentUrl(req.params.url);
      if (!targetUrl) {
        return res.status(400).json({ error: 'url is not a valid agent URL' });
      }

      const result = await applyMemberAgentMutation(orgId, (existing) => {
        const idx = existing.findIndex((a) => (canonicalizeAgentUrl(a.url) ?? a.url) === targetUrl);
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
          next: existing.filter((a) => (canonicalizeAgentUrl(a.url) ?? a.url) !== targetUrl),
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

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
 * Multi-org callers may pass `?org=…` to target a non-primary org;
 * verification goes through `resolveUserOrgMembership`.
 *
 * Concurrency: writes go through a `SELECT … FOR UPDATE` on
 * `member_profiles` so two parallel POSTs/PATCHes/DELETEs serialize
 * cleanly instead of racing on the JSONB read-modify-write the bulk
 * PUT path uses.
 */

import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
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
import { resolveUserOrgMembership } from '../utils/resolve-user-org-membership.js';
import { getPool } from '../db/client.js';
import { canonicalizeAgentUrl } from '../db/publisher-db.js';
import type { AgentConfig } from '../types.js';
import { isValidAgentType } from '../types.js';
import { resolveAgentTypes, logResolvedTypeChanges } from './member-profiles.js';
import { ensureMemberProfileExists } from '../services/member-profile-autopublish.js';
import { performCreateOrganization } from '../services/organization-bootstrap.js';
import { isDevModeEnabled, getDevUser } from '../middleware/auth.js';
import { isFreeEmail, getCompanyDomain } from '../utils/email-domain.js';
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

  /**
   * Pick the org to act on. Honors `?org=…` for multi-org callers (matching
   * the `PUT /api/me/member-profile` pattern); falls back to the user's
   * primary org when not supplied. Returns null and writes the error
   * response when the caller has no associated org or asks for an org
   * they're not a member of.
   */
  async function resolveOrgOrSendError(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<string | null> {
    const requestedOrgId =
      typeof req.query.org === 'string' && req.query.org.length > 0
        ? req.query.org
        : null;

    if (requestedOrgId) {
      const membership = await resolveUserOrgMembership(
        workos,
        req.user!.id,
        requestedOrgId,
      );
      if (!membership) {
        res.status(403).json({
          error: 'Not authorized',
          message: 'User is not a member of the requested organization',
        });
        return null;
      }
      return requestedOrgId;
    }

    const orgId = await resolvePrimaryOrganization(req.user!.id);
    if (!orgId) {
      res.status(400).json({ error: 'No organization associated with this account' });
      return null;
    }
    return orgId;
  }

  /**
   * Resolve the caller's primary org, auto-bootstrapping a fresh org if the
   * caller has zero memberships. The auto-bootstrap path is the
   * "true one-call storefront" experience: a third-party app holding only
   * a user's OAuth token can `POST /api/me/agents` once and have the org,
   * member profile, and agent registration all materialize.
   *
   * `resolvePrimaryOrganization` already derives from `organization_memberships`
   * when `users.primary_organization_id` is null, so a `null` return there
   * means the user truly has zero memberships — that's the only signal we
   * need to gate auto-bootstrap.
   *
   * Returns null and writes the error response on failure.
   */
  async function resolveOrAutoBootstrapOrg(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<{ orgId: string; orgAutoCreated: boolean } | null> {
    const requestedOrgId =
      typeof req.query.org === 'string' && req.query.org.length > 0
        ? req.query.org
        : null;

    if (requestedOrgId) {
      const orgId = await resolveOrgOrSendError(req, res);
      return orgId ? { orgId, orgAutoCreated: false } : null;
    }

    const primaryOrgId = await resolvePrimaryOrganization(req.user!.id);
    if (primaryOrgId) return { orgId: primaryOrgId, orgAutoCreated: false };

    // Fresh-user path: zero memberships → auto-bootstrap.
    const user = req.user!;
    const isPersonal = isFreeEmail(user.email);
    const orgName = deriveDefaultOrgName(user, isPersonal);

    const outcome = await performCreateOrganization(
      {
        user: { id: user.id, email: user.email },
        organization_name: orgName,
        is_personal: isPersonal,
        // company_type / revenue_tier / marketing_opt_in: auto-bootstrap has
        // no UI to capture these. Caller can patch the org later.
        isDevUser: !!(isDevModeEnabled() && getDevUser(req)),
        requestContext: {
          ip: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
          userAgent: (req.headers['user-agent'] as string) || 'unknown',
        },
      },
      { workos: workos!, orgDb: config.orgDb },
    );

    if (outcome.kind === 'created' || outcome.kind === 'adopted') {
      return { orgId: outcome.orgId, orgAutoCreated: true };
    }

    // Surface the auto-bootstrap failure honestly. None of these should
    // hit a fresh user in normal flow, but mapping them keeps the contract
    // legible.
    if (outcome.kind === 'domain_taken') {
      res.status(409).json({
        error: 'Organization exists',
        message: `An organization for ${outcome.domain} already exists: "${outcome.existingOrgName}". Use the join-request flow instead of registering an agent here.`,
        existing_org_id: outcome.existingOrgId,
        existing_org_name: outcome.existingOrgName,
      });
      return null;
    }
    if (outcome.kind === 'corporate_email_required') {
      // Shouldn't happen — `is_personal` is derived from `isFreeEmail`.
      res.status(400).json({ error: 'Corporate email required' });
      return null;
    }
    res.status(400).json({
      error: 'Auto-bootstrap failed',
      message: `Could not auto-create an organization for this user (${outcome.kind}). Call POST /api/organizations explicitly.`,
    });
    return null;
  }

  function deriveDefaultOrgName(
    user: { email: string; firstName?: string; lastName?: string },
    isPersonal: boolean,
  ): string {
    if (isPersonal) {
      const suffix = "'s Workspace";
      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(' ')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N} \-_'.‘’]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .substring(0, 100 - suffix.length);
      return fullName ? `${fullName}${suffix}` : 'Personal Workspace';
    }
    const domain = getCompanyDomain(user.email) || '';
    const root = domain.split('.')[0] || 'Organization';
    return root.charAt(0).toUpperCase() + root.slice(1);
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
      const resolved = await resolveOrAutoBootstrapOrg(req, res);
      if (!resolved) return;
      const { orgId, orgAutoCreated } = resolved;

      const body = (req.body ?? {}) as Partial<AgentConfig>;
      if (typeof body.url !== 'string' || body.url.length === 0) {
        return res.status(400).json({ error: 'url is required' });
      }
      if (!isParseableUrl(body.url)) {
        return res.status(400).json({ error: 'url must be a valid URL' });
      }
      // Query strings and fragments have no place in agent identity (issue
      // #3573). Reject at the boundary — `canonicalizeAgentUrl` itself
      // preserves them verbatim, so the check belongs here.
      if (body.url.includes('?') || body.url.includes('#')) {
        return res.status(400).json({ error: 'url must not contain query strings or fragments' });
      }
      const canonicalUrl = canonicalizeAgentUrl(body.url);
      if (!canonicalUrl) {
        return res.status(400).json({ error: 'url is not a valid agent URL' });
      }
      // `type` is required from the caller — never inferred. 'unknown' is
      // reserved for server-side smuggle protection (resolveAgentTypes), not
      // for client input. The caller MUST declare what kind of agent this is.
      if (typeof body.type !== 'string' || !isValidAgentType(body.type) || body.type === 'unknown') {
        return res.status(400).json({
          error: 'type is required',
          message: 'Specify one of: brand, rights, measurement, governance, creative, sales, buying, signals.',
        });
      }
      // Persist and compare in canonical form so the registered side
      // collapses with the discovered side (issue #3573).
      body.url = canonicalUrl;
      const targetUrl = canonicalUrl;

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

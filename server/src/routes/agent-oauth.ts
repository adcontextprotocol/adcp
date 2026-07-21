/**
 * Agent OAuth Routes
 *
 * Thin glue around `@adcp/sdk`'s `startWebOAuthFlow` /
 * `completeWebOAuthFlow`. The SDK owns RFC 9728 PRM discovery, RFC 8707
 * `resource` indicator forwarding, SEP-835 scope priority, dynamic
 * client registration, and PKCE — this module only adapts our auth /
 * org-ownership / `agent_contexts` plumbing onto that surface.
 *
 * Flow:
 *   1. User clicks "Authorize" → GET /api/oauth/agent/start
 *   2. We verify ownership, hand the SDK an `AgentConfig` + storage
 *      adapters, and redirect the browser to the SDK-built URL.
 *   3. AS bounces user back → GET /api/oauth/agent/callback
 *   4. SDK consumes the pending row, exchanges the code, persists
 *      tokens via our storage adapter; we redirect to oauth-complete.
 */

import { Router, Request, Response } from 'express';
import { validate as uuidValidate } from 'uuid';
import {
  startWebOAuthFlow,
  completeWebOAuthFlow,
  safeReturnTo,
  type PendingWebFlowStore,
  AgentVanishedDuringFlowError,
  ConfidentialClientNotAllowedError,
  InvalidOrExpiredFlowError,
  OAuthError,
  ProtectedResourceMetadataError,
  StateMismatchError,
  TokenExchangeError,
  discoverOAuthMetadata,
} from '@adcp/sdk/auth';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { AgentContextDatabase } from '../db/agent-context-db.js';
import { getWorkos } from '../auth/workos-client.js';
import { createWebOAuthAdapters, AgentOAuthPendingFlowStore } from './helpers/web-oauth-stores.js';
import { oauthSafeFetch } from './helpers/oauth-safe-fetch.js';
import { validateExternalUrl } from '../utils/url-security.js';

const logger = createLogger('agent-oauth');

const STATE_COOKIE = 'adcp_oauth_state';
const STATE_COOKIE_TTL_MS = 10 * 60 * 1000;
const OFFLINE_ACCESS_SCOPE = 'offline_access';
const PRM_ABSENT_MARKER = 'does not implement OAuth 2.0 Protected Resource Metadata';

export function buildDurableOAuthScopeHint(
  scopes: readonly string[] | undefined,
  allowOfflineAccess = true,
): string | undefined {
  const uniqueScopes = new Set<string>();
  for (const scope of scopes ?? []) {
    const trimmed = scope.trim();
    if (trimmed) uniqueScopes.add(trimmed);
  }
  if (allowOfflineAccess) uniqueScopes.add(OFFLINE_ACCESS_SCOPE);
  if (uniqueScopes.size === 0) return undefined;
  return [...uniqueScopes].join(' ');
}

async function durableOAuthScopeHintForAgent(agentUrl: string): Promise<string | undefined> {
  let resourceScopes: readonly string[] | undefined;
  let authorizationServerUrl: string | undefined;
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(
      agentUrl,
      undefined,
      oauthSafeFetch,
    );
    if (
      metadata.resource &&
      !checkResourceAllowed({
        requestedResource: resourceUrlFromServerUrl(agentUrl),
        configuredResource: metadata.resource,
      })
    ) {
      return undefined;
    }
    resourceScopes = metadata.scopes_supported;
    authorizationServerUrl = metadata.authorization_servers?.[0];
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes(PRM_ABSENT_MARKER)) {
      // Let startWebOAuthFlow perform canonical discovery and surface the
      // actionable third-party OAuth error; this preflight only enriches scope.
      return undefined;
    }
  }
  if (authorizationServerUrl && !validateExternalUrl(authorizationServerUrl)) {
    return undefined;
  }
  const asMetadata = await discoverAuthorizationServerMetadata(
    authorizationServerUrl ?? agentUrl,
    { fetchFn: oauthSafeFetch },
  );
  const supportedScopes = asMetadata?.scopes_supported;
  const allowOfflineAccess = !supportedScopes || supportedScopes.includes(OFFLINE_ACCESS_SCOPE);
  return buildDurableOAuthScopeHint(resourceScopes, allowOfflineAccess);
}

function isValidUUID(id: string): boolean {
  return uuidValidate(id);
}

function sanitizeErrorMessage(error: unknown): string {
  return String(error)
    .slice(0, 200)
    .replace(/[<>]/g, '');
}

function getCallbackUrl(req: Request): string {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/api/oauth/agent/callback`;
}

async function hasActiveWorkosMembership(workosUserId: string, organizationId: string): Promise<boolean> {
  let after: string | undefined;

  do {
    const page = await getWorkos().userManagement.listOrganizationMemberships({
      userId: workosUserId,
      organizationId,
      statuses: ['active'],
      limit: 100,
      after,
    });

    if ((page.data ?? []).some((membership) =>
      membership.userId === workosUserId &&
      membership.organizationId === organizationId &&
      membership.status === 'active',
    )) {
      return true;
    }

    after = page.listMetadata?.after ?? undefined;
  } while (after);

  return false;
}

async function requireAgentContextAccess(
  agentContextDb: AgentContextDatabase,
  agentContextId: string,
  workosUserId: string,
): Promise<
  | { ok: true; agentContext: NonNullable<Awaited<ReturnType<AgentContextDatabase['getById']>>> }
  | { ok: false; status: number; error: string }
> {
  const agentContext = await agentContextDb.getById(agentContextId);
  if (!agentContext) {
    return { ok: false, status: 404, error: 'Agent context not found' };
  }

  if (!(await hasActiveWorkosMembership(workosUserId, agentContext.organization_id))) {
    return { ok: false, status: 403, error: 'Access denied' };
  }

  return { ok: true, agentContext };
}

export function createMembershipGuardedPendingFlowStore(
  baseStore: PendingWebFlowStore,
  workosUserId: string,
): PendingWebFlowStore {
  return {
    put: (flow) => baseStore.put(flow),
    ...(baseStore.cleanupExpired && {
      cleanupExpired: () => baseStore.cleanupExpired!(),
    }),
    async consume(state) {
      const flow = await baseStore.consume(state);
      if (!flow) return null;

      const flowOrgId = flow.carry?.organization_id;
      if (
        typeof flowOrgId !== 'string' ||
        !(await hasActiveWorkosMembership(workosUserId, flowOrgId))
      ) {
        logger.warn(
          { agentId: flow.agentId, flowOrgIdPresent: typeof flowOrgId === 'string' },
          'OAuth callback org mismatch before token exchange',
        );
        return null;
      }

      return flow;
    },
  };
}

// Periodic cleanup of expired pending-flow rows (the SDK deletes on
// consume, but rows abandoned mid-flow still need a sweeper).
const cleanupStore = new AgentOAuthPendingFlowStore();
const cleanupTimer = setInterval(() => {
  cleanupStore.cleanupExpired().catch(() => undefined);
}, 5 * 60 * 1000);
cleanupTimer.unref();

/**
 * Map an `@adcp/sdk` web-flow error to a stable error code we surface
 * via the oauth-complete redirect. Keeps the user-facing copy generic
 * — the structured code is for support / diagnostics.
 */
function classifyCallbackError(err: unknown): { code: string; message: string } {
  if (err instanceof InvalidOrExpiredFlowError) {
    return { code: 'invalid_or_expired_flow', message: 'Invalid or expired OAuth session' };
  }
  if (err instanceof StateMismatchError) {
    return { code: 'state_mismatch', message: 'OAuth state does not match this browser session' };
  }
  if (err instanceof TokenExchangeError) {
    return { code: err.oauthErrorCode ?? 'token_exchange_failed', message: 'Token exchange failed' };
  }
  if (err instanceof ProtectedResourceMetadataError) {
    return { code: 'protected_resource_metadata_error', message: 'Agent OAuth metadata is invalid' };
  }
  if (err instanceof AgentVanishedDuringFlowError) {
    return { code: 'agent_vanished', message: 'Agent was removed during the OAuth flow' };
  }
  if (err instanceof ConfidentialClientNotAllowedError) {
    return { code: 'confidential_client_not_allowed', message: 'Authorization server requires a confidential client' };
  }
  return { code: 'oauth_error', message: err instanceof Error ? err.message : 'Unknown error' };
}

export function createAgentOAuthRouter(): Router {
  const router = Router();
  const agentContextDb = new AgentContextDatabase();

  /**
   * Start OAuth flow for an agent
   * GET /api/oauth/agent/start?agent_context_id=...
   */
  router.get('/start', requireAuth, async (req: Request, res: Response) => {
    try {
      const { agent_context_id, return_to } = req.query;
      const returnTo = typeof return_to === 'string' ? safeReturnTo(return_to) : undefined;

      if (!agent_context_id || typeof agent_context_id !== 'string') {
        return res.status(400).json({ error: 'agent_context_id is required' });
      }

      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const access = await requireAgentContextAccess(agentContextDb, agent_context_id, userId);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
      const agentContext = access.agentContext;
      const organizationId = agentContext.organization_id;

      const redirectUri = getCallbackUrl(req);

      // Stale-client clearing. `loadAgent` already filters oauth_client
      // by registered_redirect_uri, so the SDK would skip the cached row
      // anyway — but tokens issued to that client are also dead, and we
      // want them gone before the SDK persists fresh ones. (Today's
      // `clearOAuthClient` clears tokens too.)
      const existingClient = await agentContextDb.getOAuthClient(agent_context_id);
      if (existingClient && existingClient.registered_redirect_uri !== redirectUri) {
        logger.info(
          {
            agentUrl: agentContext.agent_url,
            oldRedirectUri: existingClient.registered_redirect_uri ?? '(unknown)',
            newRedirectUri: redirectUri,
          },
          'Redirect URI changed — clearing stale OAuth client and tokens',
        );
        await agentContextDb.clearOAuthClient(agent_context_id);
      }

      const { pendingFlowStore, agentStorage } = createWebOAuthAdapters({
        agentContextDb,
        redirectUri,
      });

      const agent = await agentStorage.loadAgent(agent_context_id);
      if (!agent) {
        // Vanishingly rare — the row existed two queries ago. Surface as
        // 404 rather than handing the SDK undefined and triggering a
        // generic 500 on the next field access.
        return res.status(404).json({ error: 'Agent context not found' });
      }

      const carry: Record<string, unknown> = {
        organization_id: organizationId,
        user_id: userId,
        ...(returnTo && { return_to: returnTo }),
      };

      const scopeHint = await durableOAuthScopeHintForAgent(agent.agent_uri);
      const { authorizationUrl, state } = await startWebOAuthFlow({
        agent,
        redirectUri,
        pendingFlowStore,
        agentStorage,
        fetch: oauthSafeFetch,
        carry,
        ...(scopeHint && { scopeHint }),
        ...(scopeHint && { clientMetadata: { scope: scopeHint } }),
      });

      // Browser-binding for CSRF (SEP-835 §state guidance). The cookie
      // value must equal the AS-supplied `state` on the callback;
      // /callback rejects mismatches and missing cookies before consuming
      // the pending row.
      res.cookie(STATE_COOKIE, state, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        maxAge: STATE_COOKIE_TTL_MS,
        path: '/api/oauth/agent/callback',
      });

      logger.info({ agentUrl: agentContext.agent_url }, 'Starting OAuth flow');
      res.redirect(authorizationUrl);
    } catch (error) {
      // OAuthError (and subclasses) is the SDK's signal that the *agent*
      // returned bad/missing OAuth data — no metadata at the well-known
      // URL, malformed PRM, AS rejected the request, etc. That's an
      // expected third-party state, not a server failure, so log at
      // `warn` to keep the pino → posthog hook from paging #aao-errors.
      // Same convention as the `AuthenticationRequiredError` branch in
      // server/src/http.ts and the slack-client expected-error sites.
      if (error instanceof OAuthError) {
        logger.warn({ error, code: error.code }, 'OAuth flow start failed (agent-side)');
      } else {
        logger.error({ error }, 'Failed to start OAuth flow');
      }
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error');
      res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent(message)}`);
    }
  });

  /**
   * OAuth callback handler
   * GET /api/oauth/agent/callback?code=...&state=...
   *
   * Authenticated. The browser session that started the flow must be the
   * one that finishes it — without that, a leaked `state` (logs, Referer,
   * shoulder-surf) plus an attacker-initiated authorize step is enough to
   * inject tokens into another user's `agent_contexts` row.
   *
   * Defense layers:
   *   1. `requireAuth` — must have a live session, not just a state value.
   *   2. `expectedState` — mandatory; the cookie set on /start must match
   *      what the AS bounced back. Missing cookie aborts the flow.
   *   3. Pre-token-exchange org check — `flow.carry.organization_id` must
   *      still be an active org for the calling user before the SDK can
   *      exchange the code or persist tokens.
   */
  router.get('/callback', requireAuth, async (req: Request, res: Response) => {
    const clearStateCookie = () => res.clearCookie(STATE_COOKIE, { path: '/api/oauth/agent/callback' });
    const { code, state, error, error_description } = req.query;

    if (error) {
      logger.warn({ error, error_description }, 'OAuth error from provider');
      const safeError = sanitizeErrorMessage(error_description || error);
      clearStateCookie();
      return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent(safeError)}`);
    }

    if (typeof code !== 'string' || code.length === 0) {
      clearStateCookie();
      return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent('No authorization code received')}`);
    }
    if (typeof state !== 'string' || state.length === 0) {
      clearStateCookie();
      return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent('No state parameter received')}`);
    }

    const expectedState = req.cookies?.[STATE_COOKIE];
    clearStateCookie();
    if (typeof expectedState !== 'string' || expectedState.length === 0) {
      logger.warn({}, 'OAuth callback missing state cookie — refusing to consume pending flow');
      const params = new URLSearchParams({
        success: 'false',
        error: 'OAuth state cookie missing — start the flow again from this browser',
        code: 'state_cookie_missing',
      });
      return res.redirect(`/oauth-complete.html?${params.toString()}`);
    }

    const userId = req.user?.id;
    if (!userId) {
      // requireAuth should already have rejected — defensive only.
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const redirectUri = getCallbackUrl(req);
    const { pendingFlowStore, agentStorage } = createWebOAuthAdapters({
      agentContextDb,
      redirectUri,
    });
    const guardedPendingFlowStore = createMembershipGuardedPendingFlowStore(pendingFlowStore, userId);

    try {
      const result = await completeWebOAuthFlow({
        state,
        code,
        pendingFlowStore: guardedPendingFlowStore,
        agentStorage,
        fetch: oauthSafeFetch,
        expectedState,
      });

      // Defense in depth: the guarded pending-flow store already checked
      // active membership before token exchange/persistence. At this point
      // only reject malformed carry data without making another external
      // WorkOS call after tokens may have been saved.
      const flowOrgId = result.carry?.organization_id;
      if (typeof flowOrgId !== 'string') {
        logger.warn(
          { agentUrl: result.agentUrl, flowOrgIdPresent: typeof flowOrgId === 'string' },
          'OAuth callback org mismatch — refusing token persistence path',
        );
        // Tokens were just persisted by the SDK; immediately revoke
        // them at the agent_context level so the cross-org user
        // doesn't end up with usable bearer tokens.
        await agentContextDb.removeOAuthTokens(result.agentId).catch((err) => {
          logger.error({ err, agentId: result.agentId }, 'Failed to revoke tokens after org mismatch');
        });
        const params = new URLSearchParams({
          success: 'false',
          error: 'OAuth flow does not match this session',
          code: 'org_mismatch',
        });
        return res.redirect(`/oauth-complete.html?${params.toString()}`);
      }

      if (!result.persisted) {
        logger.warn({ agentUrl: result.agentUrl }, 'OAuth tokens not persisted — agent storage no-op');
        const params = new URLSearchParams({
          success: 'false',
          error: 'Tokens were not saved',
          code: 'tokens_not_persisted',
        });
        return res.redirect(`/oauth-complete.html?${params.toString()}`);
      }

      const agentHost = (() => {
        try {
          return new URL(result.agentUrl).hostname;
        } catch {
          return 'agent';
        }
      })();

      logger.info({ agentUrl: result.agentUrl }, 'OAuth tokens saved successfully');

      const successParams = new URLSearchParams({ success: 'true', agent: agentHost });
      const carryReturnTo = result.carry?.return_to;
      if (typeof carryReturnTo === 'string') {
        const safe = safeReturnTo(carryReturnTo);
        if (safe) successParams.set('return_to', safe);
      }
      return res.redirect(`/oauth-complete.html?${successParams.toString()}`);
    } catch (err) {
      const { code: errCode, message } = classifyCallbackError(err);
      logger.warn({ err, code: errCode }, 'OAuth callback failed');
      const params = new URLSearchParams({
        success: 'false',
        error: sanitizeErrorMessage(message),
        code: errCode,
      });
      return res.redirect(`/oauth-complete.html?${params.toString()}`);
    }
  });

  /**
   * Clear OAuth tokens for an agent
   * DELETE /api/oauth/agent/:agent_context_id
   */
  router.delete('/:agent_context_id', requireAuth, async (req: Request, res: Response) => {
    try {
      const { agent_context_id } = req.params;
      if (!isValidUUID(agent_context_id)) {
        return res.status(400).json({ error: 'Invalid agent_context_id format' });
      }

      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const access = await requireAgentContextAccess(agentContextDb, agent_context_id, userId);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }

      await agentContextDb.removeOAuthTokens(agent_context_id);
      logger.info({ agentContextId: agent_context_id }, 'OAuth tokens cleared');
      res.json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Failed to clear OAuth tokens');
      res.status(500).json({ error: 'Failed to clear OAuth tokens' });
    }
  });

  /**
   * Check OAuth status for an agent
   * GET /api/oauth/agent/:agent_context_id/status
   */
  router.get('/:agent_context_id/status', requireAuth, async (req: Request, res: Response) => {
    try {
      const { agent_context_id } = req.params;
      if (!isValidUUID(agent_context_id)) {
        return res.status(400).json({ error: 'Invalid agent_context_id format' });
      }

      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const access = await requireAgentContextAccess(agentContextDb, agent_context_id, userId);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
      const agentContext = access.agentContext;

      const metadata = await discoverOAuthMetadata(agentContext.agent_url, {
        fetch: oauthSafeFetch,
      });
      const agentSupportsOAuth = !!metadata;
      const hasValidTokens = agentContextDb.hasValidOAuthTokens(agentContext);

      res.json({
        supportsOAuth: agentSupportsOAuth,
        hasOAuthClient: agentContext.has_oauth_client,
        hasOAuthTokens: agentContext.has_oauth_token,
        hasValidTokens,
        tokenExpiresAt: agentContext.oauth_token_expires_at,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to check OAuth status');
      res.status(500).json({ error: 'Failed to check OAuth status' });
    }
  });

  return router;
}

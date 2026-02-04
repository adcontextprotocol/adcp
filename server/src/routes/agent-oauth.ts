/**
 * Agent OAuth Routes
 *
 * Handles OAuth 2.0 authorization flow for AdCP agents.
 * Users can authorize agents that require OAuth authentication.
 *
 * Flow:
 * 1. User clicks "Authorize" -> GET /api/oauth/agent/start
 * 2. Redirect to agent's OAuth authorization endpoint
 * 3. User authorizes in browser
 * 4. Callback -> GET /api/oauth/agent/callback
 * 5. Exchange code for tokens, store in database
 * 6. Redirect back to agent management page
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { validate as uuidValidate } from 'uuid';
import { discoverOAuthMetadata } from '@adcp/client/auth';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { AgentContextDatabase, OAuthTokens, OAuthClient } from '../db/agent-context-db.js';
import { getWebMemberContext } from '../addie/member-context.js';

/**
 * Validate UUID format for route parameters
 */
function isValidUUID(id: string): boolean {
  return uuidValidate(id);
}

/**
 * Sanitize error messages for safe inclusion in URLs
 */
function sanitizeErrorMessage(error: unknown): string {
  return String(error)
    .slice(0, 200)
    .replace(/[<>]/g, '');
}

// Type for token response
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

// Type for client registration response
interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
}

const logger = createLogger('agent-oauth');

// Pending request context for auto-retry after OAuth
interface PendingRequest {
  task: string;
  params: Record<string, unknown>;
}

// In-memory store for pending OAuth flows (state -> flow data)
// In production, consider using Redis for multi-instance deployments
interface PendingOAuthFlow {
  agentContextId: string;
  organizationId: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  agentUrl: string;
  pendingRequest?: PendingRequest;
  createdAt: Date;
}

const pendingFlows = new Map<string, PendingOAuthFlow>();

// Warn about in-memory storage in production
if (process.env.NODE_ENV === 'production') {
  logger.warn('OAuth pending flows stored in memory - may cause issues with multiple instances or restarts');
}

// Clean up old pending flows (older than 10 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  for (const [state, flow] of pendingFlows.entries()) {
    if (now - flow.createdAt.getTime() > maxAge) {
      pendingFlows.delete(state);
    }
  }
}, 60 * 1000); // Run every minute

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate state parameter for CSRF protection
 */
function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  tokenUrl: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret?: string
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId,
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  const data = await response.json() as TokenResponse;

  const tokens: OAuthTokens = {
    access_token: data.access_token,
  };

  if (data.refresh_token) {
    tokens.refresh_token = data.refresh_token;
  }

  if (data.expires_in) {
    tokens.expires_at = new Date(Date.now() + data.expires_in * 1000);
  }

  return tokens;
}

/**
 * Register OAuth client dynamically
 */
async function registerOAuthClient(
  registrationUrl: string,
  redirectUri: string,
  clientName: string
): Promise<OAuthClient> {
  const response = await fetch(registrationUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client (PKCE)
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Client registration failed: ${response.status} ${error}`);
  }

  const data = await response.json() as ClientRegistrationResponse;
  return {
    client_id: data.client_id,
    client_secret: data.client_secret,
    registered_redirect_uri: redirectUri,
  };
}

/**
 * Create agent OAuth routes
 */
export function createAgentOAuthRouter(): Router {
  const router = Router();
  const agentContextDb = new AgentContextDatabase();

  // Get the base URL for callbacks
  const getCallbackUrl = (req: Request): string => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${protocol}://${host}/api/oauth/agent/callback`;
  };

  /**
   * Start OAuth flow for an agent
   * GET /api/oauth/agent/start?agent_context_id=...
   */
  router.get('/start', requireAuth, async (req: Request, res: Response) => {
    try {
      const { agent_context_id, pending_task, pending_params } = req.query;

      if (!agent_context_id || typeof agent_context_id !== 'string') {
        return res.status(400).json({ error: 'agent_context_id is required' });
      }

      // Parse pending request context (for auto-retry after OAuth)
      let pendingRequest: PendingRequest | undefined;
      if (pending_task && typeof pending_task === 'string') {
        try {
          const params = pending_params && typeof pending_params === 'string'
            ? JSON.parse(decodeURIComponent(pending_params))
            : {};
          pendingRequest = { task: pending_task, params };
        } catch (error) {
          logger.warn({ error, pending_params }, 'Failed to parse pending request params - continuing without retry context');
        }
      }

      // Get user ID from authenticated request
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get member context for organization
      const memberContext = await getWebMemberContext(userId);
      if (!memberContext?.organization?.workos_organization_id) {
        return res.status(401).json({ error: 'No organization found' });
      }

      const organizationId = memberContext.organization.workos_organization_id;

      // Get agent context
      const agentContext = await agentContextDb.getById(agent_context_id);
      if (!agentContext) {
        return res.status(404).json({ error: 'Agent context not found' });
      }

      // Verify organization ownership
      if (agentContext.organization_id !== organizationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Discover OAuth endpoints
      const metadata = await discoverOAuthMetadata(agentContext.agent_url);
      if (!metadata) {
        return res.status(400).json({
          error: 'Agent does not support OAuth',
          message: 'No OAuth metadata found at the agent URL',
        });
      }

      const redirectUri = getCallbackUrl(req);

      // Check if we have a registered client, or need to register
      let client = await agentContextDb.getOAuthClient(agent_context_id);

      // Check if redirect_uri has changed (e.g., environment change)
      // Also clear client if we don't know what redirect_uri it was registered with
      // (happens for clients created before we started tracking redirect_uri)
      if (client && (!client.registered_redirect_uri || client.registered_redirect_uri !== redirectUri)) {
        logger.info(
          {
            agentUrl: agentContext.agent_url,
            oldRedirectUri: client.registered_redirect_uri || '(unknown)',
            newRedirectUri: redirectUri
          },
          'Redirect URI changed or unknown, re-registering OAuth client'
        );
        await agentContextDb.clearOAuthClient(agent_context_id);
        client = null;
      }

      if (!client && metadata.registration_endpoint) {
        // Dynamic client registration
        logger.info({ agentUrl: agentContext.agent_url, redirectUri }, 'Registering OAuth client');
        client = await registerOAuthClient(
          metadata.registration_endpoint,
          redirectUri,
          'AgenticAdvertising.org'
        );
        await agentContextDb.saveOAuthClient(agent_context_id, client);
      }

      if (!client) {
        return res.status(400).json({
          error: 'OAuth client not configured',
          message: 'Agent requires OAuth but does not support dynamic registration. Please contact the agent provider.',
        });
      }

      // Generate PKCE and state
      const { verifier, challenge } = generatePKCE();
      const state = generateState();

      // Store pending flow
      pendingFlows.set(state, {
        agentContextId: agent_context_id,
        organizationId,
        userId,
        codeVerifier: verifier,
        redirectUri,
        agentUrl: agentContext.agent_url,
        pendingRequest,
        createdAt: new Date(),
      });

      // Build authorization URL
      const authUrl = new URL(metadata.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', client.client_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      logger.info({ agentUrl: agentContext.agent_url, state }, 'Starting OAuth flow');

      // Redirect to authorization endpoint
      res.redirect(authUrl.toString());
    } catch (error) {
      logger.error({ error }, 'Failed to start OAuth flow');
      res.status(500).json({ error: 'Failed to start OAuth flow' });
    }
  });

  /**
   * OAuth callback handler
   * GET /api/oauth/agent/callback?code=...&state=...
   */
  router.get('/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error, error_description } = req.query;

      // Handle OAuth errors
      if (error) {
        logger.warn({ error, error_description }, 'OAuth error from provider');
        const safeError = sanitizeErrorMessage(error_description || error);
        return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent(safeError)}`);
      }

      if (!code || typeof code !== 'string') {
        return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent('No authorization code received')}`);
      }

      if (!state || typeof state !== 'string') {
        return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent('No state parameter received')}`);
      }

      // Get pending flow
      const flow = pendingFlows.get(state);
      if (!flow) {
        logger.warn({ state }, 'OAuth callback with unknown state');
        return res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent('Invalid or expired OAuth session')}`);
      }

      // Remove from pending
      pendingFlows.delete(state);

      // Discover token endpoint
      const agentHost = new URL(flow.agentUrl).hostname;
      const metadata = await discoverOAuthMetadata(flow.agentUrl);
      if (!metadata) {
        return res.redirect(`/oauth-complete.html?success=false&agent=${encodeURIComponent(agentHost)}&error=${encodeURIComponent('Failed to discover OAuth endpoints')}`);
      }

      // Get client credentials
      const client = await agentContextDb.getOAuthClient(flow.agentContextId);
      if (!client) {
        return res.redirect(`/oauth-complete.html?success=false&agent=${encodeURIComponent(agentHost)}&error=${encodeURIComponent('OAuth client not found')}`);
      }

      // Exchange code for tokens
      logger.info({ agentUrl: flow.agentUrl }, 'Exchanging OAuth code for tokens');
      const tokens = await exchangeCodeForTokens(
        metadata.token_endpoint,
        code,
        flow.codeVerifier,
        flow.redirectUri,
        client.client_id,
        client.client_secret
      );

      // Save tokens
      await agentContextDb.saveOAuthTokens(flow.agentContextId, tokens);

      logger.info({ agentUrl: flow.agentUrl, hasPendingRequest: !!flow.pendingRequest }, 'OAuth tokens saved successfully');

      // Redirect to success page - user can return to their conversation (Slack or web)
      res.redirect(`/oauth-complete.html?success=true&agent=${encodeURIComponent(agentHost)}`);
    } catch (error) {
      logger.error({ error }, 'OAuth callback failed');
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error');
      res.redirect(`/oauth-complete.html?success=false&error=${encodeURIComponent(message)}`);
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

      // Get user ID from authenticated request
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get member context for organization
      const memberContext = await getWebMemberContext(userId);
      if (!memberContext?.organization?.workos_organization_id) {
        return res.status(401).json({ error: 'No organization found' });
      }

      const organizationId = memberContext.organization.workos_organization_id;

      // Get agent context
      const agentContext = await agentContextDb.getById(agent_context_id);
      if (!agentContext) {
        return res.status(404).json({ error: 'Agent context not found' });
      }

      // Verify organization ownership
      if (agentContext.organization_id !== organizationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Clear OAuth tokens
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

      // Get user ID from authenticated request
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get member context for organization
      const memberContext = await getWebMemberContext(userId);
      if (!memberContext?.organization?.workos_organization_id) {
        return res.status(401).json({ error: 'No organization found' });
      }

      const organizationId = memberContext.organization.workos_organization_id;

      // Get agent context
      const agentContext = await agentContextDb.getById(agent_context_id);
      if (!agentContext) {
        return res.status(404).json({ error: 'Agent context not found' });
      }

      // Verify organization ownership
      if (agentContext.organization_id !== organizationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check OAuth support
      const metadata = await discoverOAuthMetadata(agentContext.agent_url);
      const agentSupportsOAuth = !!metadata;

      // Check token status
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

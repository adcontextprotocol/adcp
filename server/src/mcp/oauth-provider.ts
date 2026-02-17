/**
 * MCP OAuth Provider
 *
 * Implements OAuthServerProvider as an OAuth broker:
 * - Persists client registrations in PostgreSQL
 * - Persists pending auths and auth codes in PostgreSQL
 * - Delegates user authentication to WorkOS AuthKit via /auth/callback
 * - Issues its own authorization codes to MCP clients
 * - Validates AuthKit JWTs for bearer auth
 */

import crypto from 'node:crypto';
import type { Response, Request } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '../logger.js';
import * as mcpClientsDb from '../db/mcp-clients-db.js';
import * as mcpOAuthStateDb from '../db/mcp-oauth-state-db.js';

const logger = createLogger('mcp-oauth');

/**
 * WorkOS AuthKit configuration
 */
export const AUTHKIT_ISSUER =
  process.env.AUTHKIT_ISSUER || 'https://clean-gradient-46.authkit.app';

const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID;

/**
 * Whether MCP auth is enabled.
 * Disable via MCP_AUTH_DISABLED=true for local development.
 */
export const MCP_AUTH_ENABLED = process.env.MCP_AUTH_DISABLED !== 'true';

// Periodically clean up expired OAuth state rows
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const cleanupTimer = setInterval(() => mcpOAuthStateDb.cleanupExpired(), CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// ---------------------------------------------------------------------------
// JWT verification (unchanged from previous implementation)
// ---------------------------------------------------------------------------

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwks) {
    if (!WORKOS_CLIENT_ID) {
      logger.warn('MCP OAuth: WORKOS_CLIENT_ID not set — audience validation disabled');
    }
    const jwksUrl = new URL(`${AUTHKIT_ISSUER}/oauth2/jwks`);
    jwks = createRemoteJWKSet(jwksUrl);
    logger.info(
      { jwksUrl: jwksUrl.toString(), audienceValidation: !!WORKOS_CLIENT_ID },
      'MCP OAuth: JWKS configured'
    );
  }
  return jwks;
}

async function verifyAccessTokenJWT(token: string): Promise<AuthInfo> {
  const jwksInstance = getJWKS();

  const verifyOptions: { issuer: string; audience?: string } = {
    issuer: AUTHKIT_ISSUER,
  };
  if (WORKOS_CLIENT_ID) {
    verifyOptions.audience = WORKOS_CLIENT_ID;
  }

  const { payload } = await jwtVerify(token, jwksInstance, verifyOptions);

  const isM2M =
    payload.grant_type === 'client_credentials' ||
    (typeof payload.sub === 'string' && payload.sub.startsWith('client_'));

  const clientId =
    (payload.azp as string) ||
    (typeof payload.aud === 'string' ? payload.aud : payload.aud?.[0]) ||
    'unknown';

  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(' ').filter(Boolean)
      : [];

  return {
    token,
    clientId,
    scopes,
    expiresAt: payload.exp,
    extra: {
      sub: payload.sub,
      orgId: payload.org_id,
      isM2M,
      email: payload.email,
      payload,
    },
  };
}

// ---------------------------------------------------------------------------
// MCPOAuthProvider
// ---------------------------------------------------------------------------

class MCPOAuthProvider implements OAuthServerProvider {
  /**
   * SDK validates PKCE locally via challengeForAuthorizationCode,
   * then calls exchangeAuthorizationCode WITHOUT code_verifier.
   */
  skipLocalPkceValidation = false;

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (
      clientId: string,
    ): Promise<OAuthClientInformationFull | undefined> => {
      return mcpClientsDb.getClient(clientId);
    },

    registerClient: async (
      clientInfo: OAuthClientInformationFull,
    ): Promise<OAuthClientInformationFull> => {
      await mcpClientsDb.registerClient(clientInfo);
      logger.info({ clientId: clientInfo.client_id }, 'MCP OAuth: Client registered');
      return clientInfo;
    },
  };

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const pendingId = crypto.randomUUID();

    await mcpOAuthStateDb.setPendingAuth(pendingId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes || [],
      resource: params.resource?.toString(),
    });

    // Redirect to AuthKit via WorkOS SDK (reuses existing WORKOS_REDIRECT_URI)
    const { getAuthorizationUrl } = await import('../auth/workos-client.js');
    const workosState = JSON.stringify({ mcp_pending_id: pendingId });
    const authUrl = getAuthorizationUrl(workosState);

    logger.info(
      { clientId: client.client_id, pendingId },
      'MCP OAuth: Redirecting to AuthKit for login',
    );
    res.redirect(authUrl);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const data = await mcpOAuthStateDb.getAuthCode(authorizationCode);
    if (!data) {
      throw new Error('Invalid or expired authorization code');
    }
    if (data.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    return data.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    // Atomic consume: DELETE ... RETURNING prevents double-exchange race
    const data = await mcpOAuthStateDb.consumeAuthCode(authorizationCode);
    if (!data) {
      throw new Error('Invalid or expired authorization code');
    }
    if (data.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    // RFC 6749 §4.1.3: if redirect_uri was in the authorization request, it must match
    if (data.redirectUri && data.redirectUri !== redirectUri) {
      throw new Error('redirect_uri does not match the authorization request');
    }

    return {
      access_token: data.accessToken,
      token_type: 'bearer',
      refresh_token: data.refreshToken,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshTokenValue: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const { refreshTokenRaw } = await import('../auth/workos-client.js');
    const result = await refreshTokenRaw(refreshTokenValue);
    return {
      access_token: result.accessToken,
      token_type: 'bearer',
      refresh_token: result.refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyAccessTokenJWT(token);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthProvider(): MCPOAuthProvider {
  const provider = new MCPOAuthProvider();

  logger.info(
    { issuer: AUTHKIT_ISSUER, authEnabled: MCP_AUTH_ENABLED },
    'MCP OAuth: Provider configured',
  );

  return provider;
}

// ---------------------------------------------------------------------------
// MCP OAuth callback handler
// Called from /auth/callback when state contains mcp_pending_id
// ---------------------------------------------------------------------------

export async function handleMCPOAuthCallback(
  _req: Request,
  res: Response,
  workosCode: string,
  mcpPendingId: string,
): Promise<void> {
  // Atomic consume: DELETE ... RETURNING prevents double-use race
  const pending = await mcpOAuthStateDb.consumePendingAuth(mcpPendingId);
  if (!pending) {
    logger.warn({ mcpPendingId }, 'MCP OAuth: Pending auth not found or expired');
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'MCP authorization request expired or not found',
    });
    return;
  }

  // Exchange WorkOS code for tokens
  let authResult: { accessToken: string; refreshToken: string };
  try {
    const { authenticateWithCodeForTokens } = await import('../auth/workos-client.js');
    authResult = await authenticateWithCodeForTokens(workosCode);
  } catch (err) {
    logger.error({ err, mcpPendingId }, 'MCP OAuth: Failed to exchange WorkOS code');
    const errorUrl = new URL(pending.redirectUri);
    errorUrl.searchParams.set('error', 'server_error');
    errorUrl.searchParams.set('error_description', 'Failed to complete authentication');
    if (pending.state) errorUrl.searchParams.set('state', pending.state);
    res.redirect(errorUrl.toString());
    return;
  }

  // Generate local authorization code
  const localCode = crypto.randomBytes(32).toString('hex');

  await mcpOAuthStateDb.setAuthCode(localCode, {
    clientId: pending.clientId,
    codeChallenge: pending.codeChallenge,
    redirectUri: pending.redirectUri,
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken,
  });

  // Redirect to MCP client's callback URL
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', localCode);
  if (pending.state) {
    redirectUrl.searchParams.set('state', pending.state);
  }

  logger.info(
    { clientId: pending.clientId },
    'MCP OAuth: Redirecting to MCP client with authorization code',
  );
  res.redirect(redirectUrl.toString());
}

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
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { decodeJwt } from 'jose';
import { createLogger } from '../logger.js';
import { verifyWorkOSJWT } from '../auth/workos-jwt.js';
import * as mcpClientsDb from '../db/mcp-clients-db.js';
import * as mcpOAuthStateDb from '../db/mcp-oauth-state-db.js';

const logger = createLogger('mcp-oauth');

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
// JWT verification
// ---------------------------------------------------------------------------

async function verifyAccessTokenJWT(token: string): Promise<AuthInfo> {
  let verified: Awaited<ReturnType<typeof verifyWorkOSJWT>>;
  try {
    verified = await verifyWorkOSJWT(token);
  } catch (err) {
    logger.warn({ err }, 'MCP OAuth: Token verification failed');
    throw new InvalidTokenError('Invalid or expired token');
  }

  return {
    token,
    clientId: verified.clientId,
    scopes: verified.scopes,
    expiresAt: verified.expiresAt,
    extra: {
      sub: verified.sub,
      orgId: verified.orgId,
      isM2M: verified.isM2M,
      email: verified.email,
      payload: verified.payload,
    },
  };
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

/**
 * Extract remaining seconds until expiry from a JWT access token.
 * Returns undefined if the token can't be decoded or has no exp claim.
 */
function getExpiresIn(accessToken: string): number | undefined {
  try {
    // decodeJwt skips signature verification — safe here because the token was
    // just issued by WorkOS and hasn't crossed a trust boundary.
    const payload = decodeJwt(accessToken);
    if (typeof payload.exp === 'number') {
      return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
    }
  } catch {
    // ignore decode errors
  }
  return undefined;
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
      expires_in: getExpiresIn(data.accessToken),
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
      expires_in: getExpiresIn(result.accessToken),
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
    { authEnabled: MCP_AUTH_ENABLED },
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
  let authResult: Awaited<ReturnType<typeof import('../auth/workos-client.js').authenticateWithCodeForTokens>>;
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

  // Upsert the user into our local table so downstream code (REST requireAuth,
  // /api/me/*, dashboard queries) can find them by workos_user_id. The
  // cookie-based /auth/callback path does the same upsert; without it,
  // users who first arrive via the MCP OAuth flow don't exist locally and
  // REST auth rejects their JWT.
  //
  // On failure we log and continue — we still issue the OAuth code so /mcp
  // works. The user will see a 401 the first time they call /api/*, with a
  // corresponding warn log ("Bearer JWT verified but user not found in
  // local DB"). A retry (re-SSO) recovers; a persistent failure indicates
  // a DB problem that operators need to investigate, not a per-user issue.
  try {
    const { getPool } = await import('../db/client.js');
    const { user } = authResult;
    await getPool().query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [user.id, user.email, user.firstName, user.lastName, user.emailVerified, user.createdAt, user.updatedAt],
    );
  } catch (upsertErr) {
    logger.error({ err: upsertErr }, 'MCP OAuth: Failed to upsert user on callback');
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

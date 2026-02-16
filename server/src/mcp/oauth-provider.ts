/**
 * MCP OAuth Provider
 *
 * Configures ProxyOAuthServerProvider to proxy OAuth 2.1 to WorkOS AuthKit.
 * All OAuth endpoints (authorize, token, register) are proxied to AuthKit.
 * JWT validation uses AuthKit's JWKS endpoint.
 */

import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '../logger.js';

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

/**
 * JWKS for token verification (cached and auto-refreshed by jose)
 */
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

/**
 * Validate a JWT access token and return AuthInfo for the MCP SDK.
 *
 * Checks signature via JWKS, issuer, audience (if configured), and expiry.
 * Stashes user claims in `extra` for the MCPAuthContext bridge.
 */
async function verifyAccessToken(token: string): Promise<AuthInfo> {
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

  // Derive clientId from azp (authorized party) or audience
  const clientId =
    (payload.azp as string) ||
    (typeof payload.aud === 'string' ? payload.aud : payload.aud?.[0]) ||
    'unknown';

  // Parse scopes from space-delimited scope claim
  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(' ').filter(Boolean)
      : [];

  // WorkOS AuthKit JWTs always include exp. jose's jwtVerify rejects
  // tokens without exp by default, so payload.exp is guaranteed here.
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

/**
 * Return a minimal client record for any clientId.
 *
 * AuthKit is the source of truth for client registration.
 * The SDK's authenticateClient middleware requires a non-null return,
 * but since MCP clients are public (no client_secret), no secret
 * checking occurs. AuthKit validates the client_id during token exchange.
 */
async function getClient(
  clientId: string
): Promise<OAuthClientInformationFull | undefined> {
  return { client_id: clientId, redirect_uris: [] } as OAuthClientInformationFull;
}

/**
 * Create the OAuth provider that proxies all OAuth requests to AuthKit.
 */
export function createOAuthProvider(): ProxyOAuthServerProvider {
  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${AUTHKIT_ISSUER}/oauth2/authorize`,
      tokenUrl: `${AUTHKIT_ISSUER}/oauth2/token`,
      registrationUrl: `${AUTHKIT_ISSUER}/oauth2/register`,
    },
    verifyAccessToken,
    getClient,
  });

  logger.info(
    { issuer: AUTHKIT_ISSUER, authEnabled: MCP_AUTH_ENABLED },
    'MCP OAuth: Provider configured'
  );

  return provider;
}

/**
 * WorkOS JWT verification — shared between MCP OAuth and REST API auth.
 *
 * WorkOS signs all user-management access tokens with the JWKS exposed at
 * `https://api.workos.com/sso/jwks/<client_id>`. Both the MCP OAuth provider
 * and the REST requireAuth middleware use the same verifier so a single
 * token issued by the MCP OAuth flow works across both surfaces.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createLogger } from '../logger.js';

const logger = createLogger('workos-jwt');

/**
 * Read `WORKOS_CLIENT_ID` at call time rather than at module import.
 * Vitest can evaluate `workos-jwt.ts` before a test file has had a
 * chance to set the env var, so capturing the value in a module-level
 * constant leaves tests with a stale `undefined`.
 */
function workosClientId(): string | undefined {
  return process.env.WORKOS_CLIENT_ID;
}

/**
 * Resolver used to verify tokens. `createRemoteJWKSet` returns one of
 * these; we widen the type here so tests can swap in a static-key
 * resolver built with `jose.generateKeyPair`, without having to stand
 * up an HTTP server to host a JWKS endpoint.
 */
type KeyResolver = Parameters<typeof jwtVerify>[1];

export interface VerifiedWorkOSToken {
  sub: string;
  clientId: string;
  email?: string;
  orgId?: string;
  isM2M: boolean;
  scopes: string[];
  expiresAt?: number;
  payload: JWTPayload;
}

let jwks: KeyResolver | null = null;

function getJWKS(): KeyResolver {
  if (!jwks) {
    const clientId = workosClientId();
    if (!clientId) {
      throw new Error('WORKOS_CLIENT_ID is required for JWT verification');
    }
    const jwksUrl = new URL(`https://api.workos.com/sso/jwks/${clientId}`);
    jwks = createRemoteJWKSet(jwksUrl);
    logger.info({ jwksUrl: jwksUrl.toString() }, 'WorkOS JWKS configured');
  }
  return jwks;
}

/**
 * Test-only hook: swap in a local key resolver (e.g. one built from a
 * `jose.generateKeyPair` public key) so `verifyWorkOSJWT` can be
 * exercised end-to-end without reaching out to WorkOS. Pass `null` to
 * reset to the production resolver.
 */
export function __setJWKSForTesting(resolver: KeyResolver | null): void {
  jwks = resolver;
}

/**
 * Quick heuristic — does this string look like a compact JWT?
 * Three base64url-ish segments separated by dots. Used to distinguish
 * JWTs from opaque API keys without attempting signature verification.
 */
export function looksLikeJWT(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * Verify a WorkOS-signed JWT. Throws on any verification failure
 * (bad signature, expired, wrong application, malformed). On success,
 * returns the extracted claims the app cares about.
 *
 * WorkOS user tokens don't include a stable `iss` or `aud`, but they
 * do carry the application identifier — as `azp` (OIDC) and/or
 * `client_id` (RFC 9068). We reject any token whose application
 * identifier is not our own `WORKOS_CLIENT_ID`; otherwise a sibling
 * application in the same WorkOS tenant could mint tokens that pass
 * signature verification against our shared JWKS.
 */
export async function verifyWorkOSJWT(token: string): Promise<VerifiedWorkOSToken> {
  const jwksInstance = getJWKS();

  const { payload } = await jwtVerify(token, jwksInstance);

  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  const clientIdClaim =
    typeof payload.client_id === 'string' ? payload.client_id : undefined;
  const applicationId = azp ?? clientIdClaim;
  if (!applicationId || applicationId !== workosClientId()) {
    throw new Error(
      `Token application id ("${applicationId ?? 'missing'}") does not match this application`,
    );
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const isM2M =
    payload.grant_type === 'client_credentials' || sub.startsWith('client_');

  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(' ').filter(Boolean)
      : [];

  return {
    sub,
    clientId: applicationId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    orgId: typeof payload.org_id === 'string' ? payload.org_id : undefined,
    isM2M,
    scopes,
    expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
    payload,
  };
}

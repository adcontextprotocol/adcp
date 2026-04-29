/**
 * Resolve the caller's WorkOS organization ID across the three supported
 * authentication shapes the registry API accepts:
 *
 *   1. WorkOS OIDC access token (RS256 JWT, `org_id` claim) — third-party
 *      OAuth clients obtained via AuthKit's authorization-code flow. Verified
 *      against the WorkOS JWKS endpoint.
 *   2. WorkOS API key (sk_* / wos_api_key_* prefixes) — server-to-server
 *      integrations. Validated via the existing `validateWorkOSApiKey` helper.
 *   3. Sealed session — web/native app sessions whose cookie or bearer
 *      unsealed in `optionalAuth`, producing `req.user`. Organization is
 *      resolved via `resolvePrimaryOrganization`, which falls back to the
 *      user's organization_memberships when the cached column is NULL.
 */

import type { Request } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isWorkOSApiKeyFormat } from '../../middleware/api-key-format.js';
import { validateWorkOSApiKey } from '../../middleware/auth.js';
import { resolvePrimaryOrganization } from '../../db/users-db.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('resolve-caller-org');

// WorkOS issues tokens signed by the key pair of the *issuing* OAuth client
// (`iss: https://auth.<domain>/user_management/<client_id>`). Each client has
// its own JWKS at `https://api.workos.com/sso/jwks/<client_id>`, so we must
// pick the JWKS per-token, not per-server. Cache one remote JWKSet per
// client so `createRemoteJWKSet`'s key-caching does its job across requests.
const jwksByClient = new Map<string, JWTVerifyGetKey>();

function jwksForIssuer(iss: string): { jwks: JWTVerifyGetKey; clientId: string } | null {
  // iss shape: https://<auth-domain>/user_management/<client_id>
  const match = iss.match(/\/user_management\/(client_[A-Za-z0-9]+)$/);
  if (!match) return null;
  const clientId = match[1];
  let jwks = jwksByClient.get(clientId);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));
    jwksByClient.set(clientId, jwks);
  }
  return { jwks, clientId };
}

export type MinimalReq = Pick<Request, 'headers'> & { user?: { id?: string } };

/**
 * Extract and verify a WorkOS OIDC access token. Returns the `org_id` claim
 * on success, or `null` for API keys, sealed sessions, missing tokens, or
 * failed verification. Never throws.
 */
export async function orgIdFromBearerJwt(req: MinimalReq): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (isWorkOSApiKeyFormat(token)) return null;
  // Sealed sessions are not JWTs — skip verification to avoid JWKS noise.
  if (!token.startsWith('eyJ')) return null;
  try {
    // Decode unverified to pick the right JWKS. `jwtVerify` below re-checks
    // the signature and pins `issuer`, so an attacker can't swap iss.
    const unverified = decodeJwt(token);
    if (typeof unverified.iss !== 'string') {
      logger.warn('bearer JWT rejected: missing iss claim');
      return null;
    }
    const resolved = jwksForIssuer(unverified.iss);
    if (!resolved) {
      logger.warn({ iss: unverified.iss }, 'bearer JWT rejected: iss does not match WorkOS AuthKit pattern');
      return null;
    }
    const { payload } = await jwtVerify(token, resolved.jwks, { issuer: unverified.iss });
    if (typeof payload.org_id !== 'string') {
      logger.warn({ clientId: resolved.clientId, sub: payload.sub }, 'bearer JWT verified but has no org_id claim');
      return null;
    }
    return payload.org_id;
  } catch (err) {
    logger.warn({ err }, 'bearer JWT verification failed');
    return null;
  }
}

/**
 * Resolve the caller's organization via (in order) OIDC JWT → API key →
 * sealed-session user lookup. Returns `null` when no auth shape resolves.
 */
export async function resolveCallerOrgId(req: MinimalReq): Promise<string | null> {
  const jwtOrg = await orgIdFromBearerJwt(req);
  if (jwtOrg) return jwtOrg;

  const apiKey = await validateWorkOSApiKey(req as Request);
  if (apiKey) return apiKey.organizationId;

  if (req.user?.id) {
    try {
      return await resolvePrimaryOrganization(req.user.id);
    } catch (err) {
      logger.warn({ err, userId: req.user.id }, 'caller org resolution failed — falling back to public-only');
    }
  }

  return null;
}

/** Test hook: reset the per-client JWKS cache. */
export function __resetJwksForTests(): void {
  jwksByClient.clear();
}

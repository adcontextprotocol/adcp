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
 *      looked up via `users.primary_organization_id`.
 */

import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isWorkOSApiKeyFormat } from '../../middleware/api-key-format.js';
import { validateWorkOSApiKey } from '../../middleware/auth.js';
import { query as dbQuery } from '../../db/client.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('resolve-caller-org');

let cachedJwks: JWTVerifyGetKey | null | undefined;
function getWorkOSJwks(): JWTVerifyGetKey | null {
  if (cachedJwks !== undefined) return cachedJwks;
  const clientId = process.env.WORKOS_CLIENT_ID;
  cachedJwks = clientId
    ? createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`))
    : null;
  return cachedJwks;
}

export type MinimalReq = Pick<Request, 'headers'> & { user?: { id?: string } };

/**
 * Extract and verify a WorkOS OIDC access token. Returns the `org_id` claim
 * on success, or `null` for API keys, sealed sessions, missing tokens, or
 * failed verification. Never throws.
 */
export async function orgIdFromBearerJwt(
  req: MinimalReq,
  jwks: JWTVerifyGetKey | null = getWorkOSJwks(),
): Promise<string | null> {
  if (!jwks) return null;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (isWorkOSApiKeyFormat(token)) return null;
  // Sealed sessions are not JWTs — skip verification to avoid JWKS noise.
  if (!token.startsWith('eyJ')) return null;
  try {
    const { payload } = await jwtVerify(token, jwks);
    return typeof payload.org_id === 'string' ? payload.org_id : null;
  } catch {
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
      const row = await dbQuery<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [req.user.id],
      );
      return row.rows[0]?.primary_organization_id ?? null;
    } catch (err) {
      logger.warn({ err, userId: req.user.id }, 'caller org resolution failed — falling back to public-only');
    }
  }

  return null;
}

/** Test hook: reset the memoized JWKS fetcher. */
export function __resetJwksForTests(): void {
  cachedJwks = undefined;
}

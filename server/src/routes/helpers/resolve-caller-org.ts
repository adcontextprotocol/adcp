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
 *      unsealed in `optionalAuth`, producing `req.user`. These callers must
 *      explicitly select `x-organization-id`; the selected organization is
 *      checked against the credential that authenticated the session.
 */

import type { Request } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isWorkOSApiKeyFormat } from '../../middleware/api-key-format.js';
import { validateWorkOSApiKey } from '../../middleware/auth.js';
import { createLogger } from '../../logger.js';
import { getWorkos } from '../../auth/workos-client.js';
import { resolveUserOrgMembership } from '../../utils/resolve-user-org-membership.js';

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

export type MinimalReq = Pick<Request, 'headers'> & {
  user?: { id?: string; authWorkosUserId?: string };
};

type VerifiedBearerOrg = { organizationId: string; userId: string };

async function verifiedOrgFromBearerJwt(req: MinimalReq): Promise<VerifiedBearerOrg | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (isWorkOSApiKeyFormat(token) || !token.startsWith('eyJ')) return null;
  try {
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
    if (typeof payload.org_id !== 'string' || typeof payload.sub !== 'string') {
      logger.warn({ clientId: resolved.clientId, sub: payload.sub }, 'bearer JWT verified but has no org_id or sub claim');
      return null;
    }
    return { organizationId: payload.org_id, userId: payload.sub };
  } catch (err) {
    logger.warn({ err }, 'bearer JWT verification failed');
    return null;
  }
}

/**
 * Extract and verify a WorkOS OIDC access token. Returns the `org_id` claim
 * on success, or `null` for API keys, sealed sessions, missing tokens, or
 * failed verification. Never throws.
 */
export async function orgIdFromBearerJwt(req: MinimalReq): Promise<string | null> {
  return (await verifiedOrgFromBearerJwt(req))?.organizationId ?? null;
}

export type CallerOrganizationResolution =
  | { status: 'authorized'; organizationId: string }
  | { status: 'missing' }
  | { status: 'forbidden' };

/**
 * Resolve the caller's organization via (in order) OIDC JWT → API key →
 * explicitly selected sealed-session organization. The discriminated result
 * keeps a missing selection distinct from an unauthorized explicit one.
 */
export async function resolveCallerOrganization(req: MinimalReq): Promise<CallerOrganizationResolution> {
  const jwtOrg = await verifiedOrgFromBearerJwt(req);
  if (jwtOrg) {
    try {
      const membership = await resolveUserOrgMembership(
        getWorkos(),
        { id: jwtOrg.userId },
        jwtOrg.organizationId,
      );
      return membership
        ? { status: 'authorized', organizationId: membership.organizationId }
        : { status: 'forbidden' };
    } catch (err) {
      logger.warn({ err, selectedOrganizationId: jwtOrg.organizationId }, 'bearer organization membership revalidation failed');
      return { status: 'forbidden' };
    }
  }

  const apiKey = await validateWorkOSApiKey(req as Request);
  if (apiKey) return { status: 'authorized', organizationId: apiKey.organizationId };

  const selectedHeader = req.headers['x-organization-id'];
  const selectedOrganizationId = typeof selectedHeader === 'string' && selectedHeader.trim()
    ? selectedHeader.trim()
    : null;

  if (req.user?.id && selectedOrganizationId) {
    try {
      const membership = await resolveUserOrgMembership(
        getWorkos(),
        { id: req.user.id, authWorkosUserId: req.user.authWorkosUserId },
        selectedOrganizationId,
      );
      return membership
        ? { status: 'authorized', organizationId: membership.organizationId }
        : { status: 'forbidden' };
    } catch (err) {
      logger.warn(
        { err, selectedOrganizationId },
        'caller org resolution failed — falling back to public-only',
      );
      return { status: 'forbidden' };
    }
  }

  return { status: 'missing' };
}

export async function resolveCallerOrgId(req: MinimalReq): Promise<string | null> {
  const resolution = await resolveCallerOrganization(req);
  return resolution.status === 'authorized' ? resolution.organizationId : null;
}

/** Test hook: reset the per-client JWKS cache. */
export function __resetJwksForTests(): void {
  jwksByClient.clear();
}

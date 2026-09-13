/**
 * Resolve the caller's WorkOS organization ID across the three supported
 * authentication shapes the registry API accepts:
 *
 *   1. WorkOS OIDC access token (RS256 JWT, `org_id` claim) — third-party
 *      OAuth clients obtained via AuthKit's authorization-code flow. Verified
 *      against the WorkOS JWKS endpoint.
 *   2. WorkOS API key (sk_* / wos_api_key_* prefixes) — server-to-server
 *      integrations. Validated via the existing `validateWorkOSApiKey` helper.
 *   3. Sealed cookie session — authentication middleware supplies a fresh
 *      authorization snapshot. Only an explicitly selected organization
 *      authorized for the exact credential is returned; primary orgs are ignored.
 *
 * An explicit Bearer must supply its own verified organization. Opaque/native
 * session Bearers cannot use `req.user` to select an implicit primary organization.
 */

import type { Request, Response } from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getBearerToken, isWorkOSApiKeyFormat } from '../../middleware/api-key-format.js';
import {
  ConflictingOrganizationSelectionError,
  selectedOrganizationForAuthentication,
  validateWorkOSApiKey,
} from '../../middleware/auth.js';
import { isInvalidWorkOSJWTError, unavailableJWTKeyService, WorkOSJWTUnavailableError } from '../../auth/workos-jwt.js';
import { getAuthorizationEnforcementWorkos } from '../../auth/workos-client.js';
import { getOrganizationAuthorizationUserId, type OrgAuthorizationPrincipal } from '../../auth/organization-principal.js';
import { resolveUserOrgAuthorization } from '../../utils/resolve-user-org-authorization.js';
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

export type MinimalReq = Pick<Request, 'headers'> & Partial<Pick<Request, 'query' | 'body' | 'params'>> & {
  user?: Partial<OrgAuthorizationPrincipal>;
};

export class CallerOrganizationAuthError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(status === 401 ? 'Invalid bearer token'
      : status === 403 ? 'Conflicting organization selection'
        : 'Authorization temporarily unavailable');
    this.name = 'CallerOrganizationAuthError';
  }
}

/** Preserve authentication failures when callers also handle application errors. */
export function sendCallerOrganizationAuthError(error: unknown, res: Response): boolean {
  if (!(error instanceof CallerOrganizationAuthError)) return false;
  res.status(error.status).json({
    error: error.status === 401 ? 'invalid_bearer_token'
      : error.status === 403 ? 'organization_selection_conflict'
        : 'authorization_unavailable',
  });
  return true;
}

/**
 * Extract and verify a WorkOS OIDC access token. Returns the `org_id` claim
 * on success, or `null` for API keys, sealed sessions, missing tokens, or
 * invalid verification. Key-service and unknown verification failures throw 503.
 */
export async function orgIdFromBearerJwt(req: MinimalReq): Promise<string | null> {
  const token = getBearerToken(req.headers.authorization);
  if (!token) return null;
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
    const { payload } = await jwtVerify(token, unavailableJWTKeyService(resolved.jwks), {
      issuer: unverified.iss, algorithms: ['RS256'],
    });
    if (typeof payload.org_id !== 'string') {
      logger.warn({ clientId: resolved.clientId, sub: payload.sub }, 'bearer JWT verified but has no org_id claim');
      return null;
    }
    return payload.org_id;
  } catch (err) {
    if (isInvalidWorkOSJWTError(err)) return null;
    throw new WorkOSJWTUnavailableError();
  }
}

type ResolvedBearerOrganization =
  | { kind: 'verified'; organizationId: string }
  | { kind: 'invalid' };

/** Each validator skips unsupported formats without making provider calls. */
async function resolveBearerOrganization(req: MinimalReq): Promise<ResolvedBearerOrganization> {
  try {
    const jwtOrg = await orgIdFromBearerJwt(req);
    if (jwtOrg) return { kind: 'verified', organizationId: jwtOrg };

    const apiKey = await validateWorkOSApiKey(req as Request);
    if (apiKey) return { kind: 'verified', organizationId: apiKey.organizationId };

    return { kind: 'invalid' };
  } catch {
    throw new CallerOrganizationAuthError(503);
  }
}

/** Missing, denied, stale or unavailable cookie authority is public-only.
 * Nullable consumers must never reinterpret it as canonical-user ownership. */
async function resolveCookieOrganization(req: MinimalReq): Promise<string | null> {
  const user = req.user;
  if (user?.id && user.id !== 'admin_api_key' && !user.id.startsWith('api_key_')) {
    const principal: OrgAuthorizationPrincipal = {
      id: user.id,
      authWorkosUserId: user.authWorkosUserId,
      authorizationSnapshot: user.authorizationSnapshot,
    };
    const snapshot = principal.authorizationSnapshot;
    if (!snapshot || snapshot.authenticatedUserId !== getOrganizationAuthorizationUserId(principal)
      || snapshot.canonicalUserId !== principal.id) return null;
    try {
      // Route params may become available only after authentication middleware.
      // Reuse its conflict policy before consuming the persisted selection.
      const organizationId = selectedOrganizationForAuthentication(req, snapshot.selectedOrganizationId ?? undefined);
      if (!organizationId) return null;
      // A snapshot selection is not a grant. This resolver rechecks exact
      // membership/grant and brackets WorkOS reads with fresh snapshot checks.
      const authorization = await resolveUserOrgAuthorization(
        getAuthorizationEnforcementWorkos(), principal, organizationId,
      );
      return authorization.status === 'authorized' ? authorization.membership.organizationId : null;
    } catch (err) {
      logger.warn({ err }, 'Explicit caller organization authorization unavailable or conflicting');
      return null;
    }
  }

  return null;
}

/**
 * Resolve the caller's organization from a verified credential result.
 * Null is reserved for callers without a bearer; a supplied bearer must
 * authorize an organization or fail explicitly.
 */
export async function resolveCallerOrgId(req: MinimalReq): Promise<string | null> {
  const authorization = req.headers.authorization;
  if (getBearerToken(authorization) === null) return resolveCookieOrganization(req);

  // Capture the credential and selection before any await. Later request
  // mutation cannot substitute another key or erase an organization conflict.
  const request = req as Request;
  const credentialRequest = {
    headers: Object.freeze({ ...req.headers, authorization }),
    query: Object.freeze({ ...request.query }),
    body: Object.freeze({ ...request.body }),
    params: Object.freeze({ ...request.params }),
  };
  const credential = await resolveBearerOrganization(credentialRequest);
  if (credential.kind === 'invalid') throw new CallerOrganizationAuthError(401);

  try {
    selectedOrganizationForAuthentication(credentialRequest as Request, credential.organizationId);
  } catch (error) {
    if (error instanceof ConflictingOrganizationSelectionError) {
      throw new CallerOrganizationAuthError(403);
    }
    throw new CallerOrganizationAuthError(503);
  }
  return credential.organizationId;
}

/** Test hook: reset the per-client JWKS cache. */
export function __resetJwksForTests(): void {
  jwksByClient.clear();
}

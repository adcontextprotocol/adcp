import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { extractBearerToken, respondUnauthorized } from '@adcp/sdk/server';
import { looksLikeJWT, isInvalidWorkOSJWTError, unavailableJWTKeyService } from '../auth/workos-jwt.js';
import { selectedOrganizationForAuthentication } from '../auth/organization-selection.js';
import { getPipesWorkos } from '../auth/workos-client.js';
import { loadAuthorizationSnapshot, sameAuthorizationSnapshot } from '../db/user-authorization-snapshot-db.js';
import { bansDb } from '../db/bans-db.js';
import { resolveUserRole } from '../utils/resolve-user-role.js';
import rateLimit from 'express-rate-limit';

export const TRAINING_BUYER_RESOURCE = 'https://test-agent.adcontextprotocol.org/sales/mcp';
export const TRAINING_BUYER_METADATA_PATH = '/.well-known/oauth-protected-resource/sales/mcp';

export interface TrainingBuyerOAuthConfig {
  issuer: string;
  resource: string;
  organizationId: string;
  metadataUrl: string;
}

/** Connect uses its own issuer/JWKS and resource audience, unlike app session JWTs. */
export function trainingBuyerOAuthConfig(env: NodeJS.ProcessEnv = process.env): TrainingBuyerOAuthConfig | undefined {
  const enabled = env.TRAINING_BUYER_OAUTH_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('TRAINING_BUYER_OAUTH_ENABLED must be true or false.');
  try {
    const issuer = new URL(env.TRAINING_BUYER_OAUTH_ISSUER ?? '');
    const resource = new URL(env.TRAINING_BUYER_OAUTH_RESOURCE ?? TRAINING_BUYER_RESOURCE);
    const organizationId = env.TRAINING_BUYER_OAUTH_ORGANIZATION_ID ?? '';
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash
      || issuer.pathname !== '/' || resource.protocol !== 'https:' || resource.username || resource.password
      || resource.search || resource.hash || resource.pathname !== '/sales/mcp'
      || !/^org_[A-Za-z0-9]+$/.test(organizationId)
      || (env.TRAINING_REPORTING_GCS_CANARY_PRINCIPAL !== undefined
        && env.TRAINING_REPORTING_GCS_CANARY_PRINCIPAL !== `workos:${organizationId}`)) throw new Error();
    return { issuer: issuer.origin, resource: resource.href, organizationId,
      metadataUrl: `${resource.origin}${TRAINING_BUYER_METADATA_PATH}` };
  } catch {
    throw new Error('Buyer OAuth requires a trusted HTTPS AuthKit issuer, sales resource and matching private canary organization.');
  }
}

export function trainingBuyerMetadata(config: TrainingBuyerOAuthConfig) {
  return { resource: config.resource, authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'] };
}

class BuyerAuthorizationError extends Error {
  constructor(readonly status: 401 | 403) { super('Buyer authorization denied'); }
}

/** Only cryptographic verification is cached; mutable authority is read on every request. */
export function createTrainingBuyerOAuthMiddleware(
  config: TrainingBuyerOAuthConfig,
  fallback: RequestHandler,
  keyResolver: JWTVerifyGetKey = createRemoteJWKSet(new URL('/oauth2/jwks', config.issuer), { timeoutDuration: 5_000 }),
): RequestHandler {
  const keys = unavailableJWTKeyService(keyResolver);
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
    validate: { xForwardedForHeader: false, ip: false },
    handler: (_req, res) => { res.status(429).json({ error: 'BUYER_RATE_LIMITED' }); } });
  return async (req, res, next) => {
    const token = extractBearerToken(req);
    if (token && !looksLikeJWT(token)) return fallback(req, res, next);
    res.setHeader('Cache-Control', 'no-store');
    const unauthorized = () => respondUnauthorized(req, res, { resourceMetadata: config.metadataUrl,
      error: token ? 'invalid_token' : 'invalid_request', errorDescription: 'Sign in to the private training buyer.' });
    if (!token) return unauthorized();
    let limited = true;
    await limit(req, res, () => { limited = false; });
    if (limited) return;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.resource,
        algorithms: ['RS256'], maxTokenAge: 3_600, requiredClaims: ['exp', 'sub', 'iat', 'org_id', 'client_id', 'sid'] });
      if (typeof payload.sub !== 'string' || !payload.sub.startsWith('user_')
        || typeof payload.client_id !== 'string' || !payload.client_id.trim() || payload.client_id.length > 2048
        || typeof payload.sid !== 'string' || !payload.sid.startsWith('app_consent_')
        || payload.grant_type === 'client_credentials' || typeof payload.org_id !== 'string'
        || typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
        || payload.exp - payload.iat > 3_600) {
        throw new BuyerAuthorizationError(401);
      }
      let selected: string | null;
      try { selected = selectedOrganizationForAuthentication(req, payload.org_id); }
      catch { throw new BuyerAuthorizationError(403); }
      if (selected !== config.organizationId) throw new BuyerAuthorizationError(403);
      const before = await loadAuthorizationSnapshot(payload.sub, selected);
      if (!before) throw new BuyerAuthorizationError(401);
      if (before.authenticatedUserId !== payload.sub || before.selectedOrganizationId !== selected
        || before.credentialGrant?.organizationId !== selected
        || !['owner', 'admin'].includes(before.credentialGrant.role)) throw new BuyerAuthorizationError(403);
      const ban = await bansDb.checkPlatformBanForUserAndOrg(payload.sub, selected);
      if (ban.banned) throw new BuyerAuthorizationError(403);
      const memberships = await getPipesWorkos().userManagement.listOrganizationMemberships({ userId: payload.sub, organizationId: selected });
      const direct = memberships.data.filter(m => m.userId === payload.sub && m.organizationId === selected && m.status === 'active');
      const role = resolveUserRole(direct);
      if (role !== 'owner' && role !== 'admin') throw new BuyerAuthorizationError(403);
      // Network checks can outlive a local revocation or identity rebind.
      const after = await loadAuthorizationSnapshot(payload.sub, selected);
      if (!after || !sameAuthorizationSnapshot(before, after)) throw new BuyerAuthorizationError(403);
      const principal = `workos:${selected}`;
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      const actor = { user_id: payload.sub, organization_id: selected, client_id: payload.client_id,
        identity_id: after.identityId, authorization_epoch: after.authorizationEpoch };
      res.locals.trainingPrincipal = principal;
      res.locals.trainingOAuthActor = actor;
      (req as Request & { auth?: AuthInfo }).auth = { token: '', clientId: principal, scopes, expiresAt: payload.exp,
        extra: { training_oauth_actor: actor,
          credential: { kind: 'oauth', client_id: payload.client_id, scopes, expires_at: payload.exp } } };
      next();
    } catch (error) {
      if ((error instanceof BuyerAuthorizationError && error.status === 401) || isInvalidWorkOSJWTError(error)) return unauthorized();
      if (error instanceof BuyerAuthorizationError) { res.status(403).json({ error: 'BUYER_ACCESS_DENIED' }); return; }
      res.status(503).json({ error: 'BUYER_AUTHORIZATION_UNAVAILABLE' });
    }
  };
}

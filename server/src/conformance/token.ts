/**
 * First-party JWTs for the Addie conformance Socket Mode channel.
 *
 * Distinct from `workos-jwt.ts` (which verifies WorkOS-signed tokens):
 * these tokens are minted and verified by Addie itself, signed with
 * `CONFORMANCE_JWT_SECRET` using HS256. They're scoped to the
 * conformance channel (`scope: "conformance"`) and bound to a single
 * WorkOS organization id (`sub`).
 *
 * TTL is short (1 hour). The adopter asks Addie in chat for a fresh
 * token when one expires — there's no refresh endpoint by design.
 */

import jwt from 'jsonwebtoken';

const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_SCOPE = 'conformance' as const;

export interface ConformanceTokenClaims {
  sub: string;
  scope: typeof TOKEN_SCOPE;
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.CONFORMANCE_JWT_SECRET;
  if (!secret) {
    throw new Error('CONFORMANCE_JWT_SECRET is not configured');
  }
  return secret;
}

export interface IssuedConformanceToken {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

export function issueConformanceToken(orgId: string): IssuedConformanceToken {
  if (!orgId) {
    throw new Error('orgId is required to issue a conformance token');
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const token = jwt.sign(
    { scope: TOKEN_SCOPE, iat, exp },
    getSecret(),
    { algorithm: 'HS256', subject: orgId },
  );
  return { token, expiresAt: exp, ttlSeconds: TOKEN_TTL_SECONDS };
}

export function verifyConformanceToken(token: string): ConformanceTokenClaims {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('invalid conformance token: not an object');
  }
  const claims = decoded as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('invalid conformance token: missing sub');
  }
  if (claims.scope !== TOKEN_SCOPE) {
    throw new Error(`invalid conformance token: scope is "${String(claims.scope)}", expected "${TOKEN_SCOPE}"`);
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
    throw new Error('invalid conformance token: missing iat/exp');
  }
  return {
    sub: claims.sub,
    scope: TOKEN_SCOPE,
    iat: claims.iat,
    exp: claims.exp,
  };
}

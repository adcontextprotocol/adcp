/**
 * AAO Verification Token — signed JWT for decentralized badge verification.
 *
 * Agents earn badges by passing all declared storyboards. AAO signs a JWT
 * that anyone can verify against AAO's public key without calling AAO's API.
 */

import * as jose from 'jose';
import { randomUUID } from 'crypto';

// ── Token Payload ────────────────────────────────────────────────

export interface VerificationTokenPayload {
  agent_url: string;
  role: string;
  verified_specialisms: string[];
  /**
   * Verification axes earned. ['spec'] = protocol storyboards pass;
   * ['spec', 'live'] = also observed via canonical campaigns. Always
   * includes at least 'spec'. See VERIFICATION_MODES in services/badge-svg.ts.
   */
  verification_modes: string[];
  protocol_version?: string;
}

export interface VerificationTokenClaims extends VerificationTokenPayload {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

// ── Key Management ───────────────────────────────────────────────

let signingKey: jose.CryptoKey | undefined;
let verifyingKey: jose.CryptoKey | undefined;
let publicJwk: jose.JWK | undefined;

const ISSUER = 'https://aao.org';
const ALG = 'EdDSA';
const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Initialize keys from environment. Call once at server startup.
 *
 * Expects AAO_VERIFICATION_PRIVATE_KEY (base64-encoded PKCS8 PEM)
 * and AAO_VERIFICATION_PUBLIC_KEY (base64-encoded SPKI PEM).
 *
 * If not set, token signing is disabled (badge logic still works,
 * just without JWT tokens).
 */
export async function initVerificationKeys(): Promise<boolean> {
  const privateKeyB64 = process.env.AAO_VERIFICATION_PRIVATE_KEY;
  const publicKeyB64 = process.env.AAO_VERIFICATION_PUBLIC_KEY;

  if (!privateKeyB64 || !publicKeyB64) {
    return false;
  }

  const privatePem = Buffer.from(privateKeyB64, 'base64').toString('utf8');
  const publicPem = Buffer.from(publicKeyB64, 'base64').toString('utf8');

  signingKey = await jose.importPKCS8(privatePem, ALG);
  verifyingKey = await jose.importSPKI(publicPem, ALG);
  publicJwk = await jose.exportJWK(verifyingKey);
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';
  publicJwk.kid = 'aao-verification-1';

  return true;
}

/**
 * Sign a verification token for an agent badge.
 * Returns null if signing keys are not configured.
 */
export async function signVerificationToken(
  payload: VerificationTokenPayload,
): Promise<{ token: string; expires_at: Date } | null> {
  if (!signingKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_LIFETIME_SECONDS;

  const token = await new jose.SignJWT({
    agent_url: payload.agent_url,
    role: payload.role,
    verified_specialisms: payload.verified_specialisms,
    verification_modes: payload.verification_modes,
    ...(payload.protocol_version && { protocol_version: payload.protocol_version }),
  })
    .setProtectedHeader({ alg: ALG, kid: 'aao-verification-1' })
    .setIssuer(ISSUER)
    .setSubject(payload.agent_url)
    .setAudience('aao-verification')
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(signingKey);

  return { token, expires_at: new Date(exp * 1000) };
}

/**
 * Verify a token and return its claims. Returns null if invalid.
 */
export async function verifyVerificationToken(
  token: string,
): Promise<VerificationTokenClaims | null> {
  if (!verifyingKey) return null;

  try {
    const { payload } = await jose.jwtVerify(token, verifyingKey, {
      issuer: ISSUER,
      audience: 'aao-verification',
    });
    return payload as unknown as VerificationTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Returns the public JWK Set for publishing at /.well-known/jwks.json.
 */
export function getPublicJwks(): { keys: jose.JWK[] } {
  if (!publicJwk) return { keys: [] };
  return { keys: [publicJwk] };
}

export function isTokenSigningEnabled(): boolean {
  return !!signingKey;
}

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  signingKey = undefined;
  verifyingKey = undefined;
  publicJwk = undefined;
}

/**
 * AAO Verification Token — signed JWT for decentralized badge verification.
 *
 * Agents earn badges by passing all declared storyboards. AAO signs a JWT
 * that anyone can verify against AAO's public key without calling AAO's API.
 */

import * as jose from 'jose';
import { randomUUID } from 'crypto';
import { isVerificationMode, type VerificationMode } from './adcp-taxonomy.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'verification-token' });

/**
 * Shape constraint for the adcp_version JWT claim. Mirrors the
 * `valid_adcp_version` CHECK constraint on agent_verification_badges
 * (migration 457). MUST be the same regex on both sides — if a poisoned
 * DB row ever survives the constraint, this is the second gate before
 * an AAO-signed token can carry the value.
 */
const ADCP_VERSION_RE = /^[1-9][0-9]*\.[0-9]+$/;

export function isValidAdcpVersion(value: unknown): value is string {
  return typeof value === 'string' && ADCP_VERSION_RE.test(value);
}

// ── Token Payload ────────────────────────────────────────────────

export interface VerificationTokenPayload {
  agent_url: string;
  role: string;
  verified_specialisms: string[];
  /**
   * Verification axes earned. ['spec'] = protocol storyboards pass;
   * ['spec', 'live'] = also observed via canonical campaigns. Always
   * non-empty for a real badge. Constrained to {@link VerificationMode}
   * (see adcp-taxonomy.ts) — unknown values are filtered before signing.
   */
  verification_modes: VerificationMode[];
  /**
   * AdCP release the badge was issued against, MAJOR.MINOR (e.g. '3.0',
   * '3.1'). Load-bearing for badge identity — pairs with the (agent_url,
   * role, adcp_version) primary key in agent_verification_badges. Validated
   * at sign time and at verify time against `^\d+\.\d+$`.
   */
  adcp_version?: string;
  /**
   * Full semver of the spec build that issued this token (e.g. '3.0.0').
   * Informational metadata for support and audits — `adcp_version` is the
   * load-bearing field for badge model decisions.
   */
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

  // Defense in depth: filter modes against the known set before signing,
  // so a corrupted DB row or programming error can't put an arbitrary
  // string into a signed AAO claim.
  const safeModes = payload.verification_modes.filter(isVerificationMode);
  if (safeModes.length === 0) {
    return null;
  }

  // Validate adcp_version shape before signing — same regex as the DB
  // CHECK constraint. A poisoned DB row that smuggled a non-MAJOR.MINOR
  // value MUST NOT ride into a signed token. Fail closed: when the
  // value is present but malformed, refuse to sign rather than emit a
  // token without the claim. Otherwise verifiers reading the token
  // could conflate "no adcp_version = pre-Stage-2 legacy" with
  // "no adcp_version = the value got dropped" — a downgrade vector.
  // The badge row itself was already accepted by the DB CHECK, so a
  // failure here surfaces a programming error or an attacker who
  // bypassed the CHECK; both warrant loud failure.
  if (payload.adcp_version !== undefined && !isValidAdcpVersion(payload.adcp_version)) {
    logger.error(
      { agent_url: payload.agent_url, role: payload.role, adcp_version: payload.adcp_version },
      'Refusing to sign verification token: adcp_version did not match shape constraint',
    );
    return null;
  }

  const token = await new jose.SignJWT({
    agent_url: payload.agent_url,
    role: payload.role,
    verified_specialisms: payload.verified_specialisms,
    verification_modes: safeModes,
    ...(payload.adcp_version && { adcp_version: payload.adcp_version }),
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
 * Verify a token and return its claims. Returns null if invalid OR if the
 * payload doesn't carry the expected fields (defense against token-format
 * drift and pre-refactor tokens that lack `verification_modes`).
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

    // Runtime-validate the claim shape. Verifiers reading
    // claims.verification_modes get a guaranteed VerificationMode[] — never
    // undefined — so they can branch on it without optional-chain quirks.
    // Symmetric with the sign-time validation: every field constrained
    // here is also constrained at sign. A future signer bug, a test key,
    // or a downgrade attack that smuggled a malformed claim into an
    // otherwise-valid signature path is rejected here.
    const p = payload as Record<string, unknown>;
    if (
      typeof p.agent_url !== 'string' ||
      typeof p.role !== 'string' ||
      !Array.isArray(p.verified_specialisms) ||
      !p.verified_specialisms.every((s): s is string => typeof s === 'string') ||
      !Array.isArray(p.verification_modes) ||
      !p.verification_modes.every(isVerificationMode) ||
      p.verification_modes.length === 0
    ) {
      return null;
    }

    // adcp_version is optional (pre-Stage-2 tokens omit it), but if
    // present it MUST match the same shape the signer enforced.
    if (p.adcp_version !== undefined && !isValidAdcpVersion(p.adcp_version)) {
      return null;
    }

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

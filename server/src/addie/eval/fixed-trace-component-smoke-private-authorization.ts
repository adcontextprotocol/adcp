import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
} from './fixed-trace-component-smoke-private-authority.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/**
 * This is a verifier and persistence contract only.  It deliberately has no
 * issuer, key provisioning, provider adapter, environment switch, or runtime
 * construction path.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION =
  'addie-fixed-trace-component-smoke-signed-grant-v1' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM = 'Ed25519' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_DOMAIN =
  'adcp:addie:fixed-trace-component-smoke:private-grant:v1\0' as const;

type Cardinality = typeof FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cardinality;

export interface FixedTraceComponentSmokeSignedGrantPayload {
  readonly grantVersion: typeof FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION;
  readonly kid: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly stageId: 'stage_1_smoke';
  readonly admissionVersion: typeof FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.admissionVersion;
  readonly aggregateAdmissionFingerprint: string;
  readonly cardinality: Cardinality;
  readonly reservationMicrodollars: number;
  readonly providerCeilingMicrodollars: number;
  readonly pricingCohortDigest: string;
  /** SHA-256 commitment only. The nonce is never accepted or retained here. */
  readonly nonceCommitment: string;
}

export interface FixedTraceComponentSmokeSignedGrant {
  readonly algorithm: typeof FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM;
  readonly payload: FixedTraceComponentSmokeSignedGrantPayload;
  /** RFC 4648 base64url, unpadded. */
  readonly signature: string;
}

export interface FixedTraceComponentSmokeVerifiedGrant {
  readonly signedPayloadDigest: string;
  readonly grantDigest: string;
  readonly payload: FixedTraceComponentSmokeSignedGrantPayload;
}
export interface FixedTraceComponentSmokeTestGrantVerification {
  readonly valid: true;
  readonly signedPayloadDigest: string;
}
/** A one-shot smoke grant may not outlive this bounded interval. */
export const FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_MAX_TTL_MS = 15 * 60 * 1_000;

/**
 * Production is intentionally unprovisioned.  There is no environment lookup,
 * dynamic JWKS, key callback, key negotiation, or caller-supplied key path.
 * A later separately-reviewed private deployment must replace this module-owned
 * null registry in a dedicated change before it can verify anything.
 */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON permits only safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('non-JSON canonical value');
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function hexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function pricingCohortDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}
function kid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}
function exactIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function base64url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value);
}
function exactCardinality(value: unknown): value is Cardinality {
  try {
    const candidate = snapshotFixedTraceJson(value, 'signed grant cardinality') as Record<string, unknown>;
    return exactKeys(candidate, Object.keys(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cardinality))
      && canonicalJson(candidate) === canonicalJson(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cardinality);
  } catch { return false; }
}

/** Returns exactly the bytes covered by Ed25519, including a non-JSON domain prefix. */
export function fixedTraceComponentSmokeSignedGrantBytes(payload: FixedTraceComponentSmokeSignedGrantPayload): Buffer {
  return Buffer.from(FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_DOMAIN + canonicalJson(payload), 'utf8');
}

export function fixedTraceComponentSmokeSignedPayloadDigest(payload: FixedTraceComponentSmokeSignedGrantPayload): string {
  return createHash('sha256').update(fixedTraceComponentSmokeSignedGrantBytes(payload)).digest('hex');
}

function parsePayload(value: unknown): FixedTraceComponentSmokeSignedGrantPayload | null {
  try {
    const payload = snapshotFixedTraceJson(value, 'signed private grant payload') as Record<string, unknown>;
    if (!exactKeys(payload, ['admissionVersion', 'aggregateAdmissionFingerprint', 'cardinality', 'expiresAt', 'grantVersion', 'issuedAt', 'kid', 'nonceCommitment', 'pricingCohortDigest', 'providerCeilingMicrodollars', 'reservationMicrodollars', 'stageId'])) return null;
    if (payload.grantVersion !== FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION
      || !kid(payload.kid) || !exactIso(payload.issuedAt) || !exactIso(payload.expiresAt)
      || payload.stageId !== 'stage_1_smoke'
      || payload.admissionVersion !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.admissionVersion
      || payload.aggregateAdmissionFingerprint !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint
      || !exactCardinality(payload.cardinality)
      || payload.reservationMicrodollars !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.reservationMicrodollars
      || payload.providerCeilingMicrodollars !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.providerCeilingMicrodollars
      || !pricingCohortDigest(payload.pricingCohortDigest) || payload.pricingCohortDigest !== FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.pricingCohortDigest
      || !hexDigest(payload.nonceCommitment)
      || Date.parse(payload.issuedAt as string) >= Date.parse(payload.expiresAt as string)) return null;
    return Object.freeze(payload) as unknown as FixedTraceComponentSmokeSignedGrantPayload;
  } catch { return null; }
}

function parseGrant(value: unknown): { payload: FixedTraceComponentSmokeSignedGrantPayload; signature: Buffer } | null {
  try {
    const grant = snapshotFixedTraceJson(value, 'signed private grant') as Record<string, unknown>;
    if (!exactKeys(grant, ['algorithm', 'payload', 'signature'])
      || grant.algorithm !== FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM || !base64url(grant.signature)) return null;
    const payload = parsePayload(grant.payload);
    if (!payload) return null;
    const signature = Buffer.from(grant.signature, 'base64url');
    return signature.length === 64 ? { payload, signature } : null;
  } catch { return null; }
}

function verifyWithRegistry(value: unknown, now: Date, registry: Readonly<Record<string, string>> | null): FixedTraceComponentSmokeVerifiedGrant | null {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || registry === null) return null;
  const parsed = parseGrant(value);
  if (!parsed || Date.parse(parsed.payload.issuedAt) > now.valueOf() || Date.parse(parsed.payload.expiresAt) <= now.valueOf()
    || Date.parse(parsed.payload.expiresAt) - Date.parse(parsed.payload.issuedAt) > FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_MAX_TTL_MS) return null;
  const spki = registry[parsed.payload.kid];
  if (typeof spki !== 'string') return null;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, fixedTraceComponentSmokeSignedGrantBytes(parsed.payload), publicKey, parsed.signature)) return null;
    const signedPayloadDigest = fixedTraceComponentSmokeSignedPayloadDigest(parsed.payload);
    const verified = Object.freeze({ signedPayloadDigest,
      grantDigest: createHash('sha256').update(parsed.signature).update(signedPayloadDigest, 'utf8').digest('hex'),
      payload: parsed.payload });
    return verified;
  } catch { return null; }
}

/** Production entry point: permanently fail-closed in this unprovisioned slice. */
export function verifyFixedTraceComponentSmokeSignedGrant(_value: unknown, _now: Date): FixedTraceComponentSmokeVerifiedGrant | null {
  return null;
}

/** No caller-visible path can mint the adjacent ledger's production capability. */
export function isFixedTraceComponentSmokeVerifiedGrant(_value: unknown): _value is FixedTraceComponentSmokeVerifiedGrant {
  return false;
}

/** There is consequently no signature digest for the unconstructible production path. */
export function fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger(_value: unknown): string | null {
  return null;
}

/**
 * Test-only pure verification seam.  It is intentionally separate from the
 * production entry point; no production caller can select or inject a trust
 * root.  Tests may pass only a concrete Ed25519 KeyObject created in-process.
 */
export function verifyFixedTraceComponentSmokeSignedGrantForTest(
  value: unknown,
  now: Date,
  testTrustRoot: Readonly<{ kid: string; publicKey: KeyObject }>,
): FixedTraceComponentSmokeTestGrantVerification | null {
  if (!kid(testTrustRoot.kid) || testTrustRoot.publicKey.asymmetricKeyType !== 'ed25519') return null;
  const spki = testTrustRoot.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const verified = verifyWithRegistry(value, now, Object.freeze({ [testTrustRoot.kid]: spki.toString('base64url') }));
  return verified ? Object.freeze({ valid: true as const, signedPayloadDigest: verified.signedPayloadDigest }) : null;
}

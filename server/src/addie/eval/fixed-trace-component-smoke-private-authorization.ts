import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
  fixedTraceComponentSmokeAdmission,
} from './fixed-trace-component-smoke-admission.js';
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

type Admission = ReturnType<typeof fixedTraceComponentSmokeAdmission>;
type Cardinality = Admission['cardinality'];

export interface FixedTraceComponentSmokeSignedGrantPayload {
  readonly grantVersion: typeof FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION;
  readonly kid: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly stageId: 'stage_1_smoke';
  readonly admissionVersion: typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION;
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
/** Exact public root supplied only by the isolated one-shot composition root. */
export interface FixedTraceComponentSmokeOneShotTrustRoot {
  readonly kid: string;
  readonly spki: string;
}
export interface FixedTraceComponentSmokeOneShotGrantVerifier {
  verify(value: unknown, now: Date): FixedTraceComponentSmokeVerifiedGrant | null;
}
/** A one-shot smoke grant may not outlive this bounded interval. */
export const FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_MAX_TTL_MS = 15 * 60 * 1_000;

/**
 * Production is intentionally unprovisioned.  There is no environment lookup,
 * dynamic JWKS, key callback, key negotiation, or caller-supplied key path.
 * A later separately-reviewed private deployment must replace this module-owned
 * null registry in a dedicated change before it can verify anything.
 */
const PRODUCTION_SPKI_BY_KID: Readonly<Record<string, string>> | null = null;
/** Capability marker: only this verifier can create an input accepted by the ledger. */
const VERIFIED_GRANTS = new WeakMap<object, Buffer>();

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
function exactCardinality(value: unknown, admission: Admission): value is Cardinality {
  try {
    const candidate = snapshotFixedTraceJson(value, 'signed grant cardinality') as Record<string, unknown>;
    return exactKeys(candidate, Object.keys(admission.cardinality))
      && canonicalJson(candidate) === canonicalJson(admission.cardinality);
  } catch { return false; }
}

/** Returns exactly the bytes covered by Ed25519, including a non-JSON domain prefix. */
export function fixedTraceComponentSmokeSignedGrantBytes(payload: FixedTraceComponentSmokeSignedGrantPayload): Buffer {
  return Buffer.from(FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_DOMAIN + canonicalJson(payload), 'utf8');
}

export function fixedTraceComponentSmokeSignedPayloadDigest(payload: FixedTraceComponentSmokeSignedGrantPayload): string {
  return createHash('sha256').update(fixedTraceComponentSmokeSignedGrantBytes(payload)).digest('hex');
}

function parsePayload(value: unknown, admission: Admission): FixedTraceComponentSmokeSignedGrantPayload | null {
  try {
    const payload = snapshotFixedTraceJson(value, 'signed private grant payload') as Record<string, unknown>;
    const pricing = admission.pricing;
    if (pricing.cohortDigest === null || pricing.reservationMicrodollars === null) return null;
    if (!exactKeys(payload, ['admissionVersion', 'aggregateAdmissionFingerprint', 'cardinality', 'expiresAt', 'grantVersion', 'issuedAt', 'kid', 'nonceCommitment', 'pricingCohortDigest', 'providerCeilingMicrodollars', 'reservationMicrodollars', 'stageId'])) return null;
    if (payload.grantVersion !== FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION
      || !kid(payload.kid) || !exactIso(payload.issuedAt) || !exactIso(payload.expiresAt)
      || payload.stageId !== admission.stageControls.phaseId
      || payload.admissionVersion !== FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION
      || payload.aggregateAdmissionFingerprint !== admission.fingerprints.aggregateAdmission
      || !exactCardinality(payload.cardinality, admission)
      || payload.reservationMicrodollars !== pricing.reservationMicrodollars
      || payload.providerCeilingMicrodollars !== pricing.providerCeilingUsd * 1_000_000
      || !pricingCohortDigest(payload.pricingCohortDigest) || payload.pricingCohortDigest !== pricing.cohortDigest
      || !hexDigest(payload.nonceCommitment)
      || Date.parse(payload.issuedAt as string) >= Date.parse(payload.expiresAt as string)) return null;
    return Object.freeze(payload) as unknown as FixedTraceComponentSmokeSignedGrantPayload;
  } catch { return null; }
}

function parseGrant(value: unknown, admission: Admission): { payload: FixedTraceComponentSmokeSignedGrantPayload; signature: Buffer } | null {
  try {
    const grant = snapshotFixedTraceJson(value, 'signed private grant') as Record<string, unknown>;
    if (!exactKeys(grant, ['algorithm', 'payload', 'signature'])
      || grant.algorithm !== FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM || !base64url(grant.signature)) return null;
    const payload = parsePayload(grant.payload, admission);
    if (!payload) return null;
    const signature = Buffer.from(grant.signature, 'base64url');
    return signature.length === 64 ? { payload, signature } : null;
  } catch { return null; }
}

function verifyWithRegistry(value: unknown, now: Date, registry: Readonly<Record<string, string>> | null, mintLedgerCapability: boolean): FixedTraceComponentSmokeVerifiedGrant | null {
  const admission = fixedTraceComponentSmokeAdmission();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || registry === null) return null;
  const parsed = parseGrant(value, admission);
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
    if (mintLedgerCapability) VERIFIED_GRANTS.set(verified, Buffer.from(parsed.signature));
    return verified;
  } catch { return null; }
}

function exactOneShotTrustRoot(value: unknown): FixedTraceComponentSmokeOneShotTrustRoot | null {
  try {
    const root = snapshotFixedTraceJson(value, 'private one-shot trust root') as Record<string, unknown>;
    if (!exactKeys(root, ['kid', 'spki']) || !kid(root.kid) || typeof root.spki !== 'string' || !/^[A-Za-z0-9_-]+$/.test(root.spki)) return null;
    const publicKey = createPublicKey({ key: Buffer.from(root.spki, 'base64url'), format: 'der', type: 'spki' });
    return publicKey.asymmetricKeyType === 'ed25519' ? Object.freeze({ kid: root.kid, spki: root.spki }) : null;
  } catch { return null; }
}

/**
 * Constructs the private one-shot verifier only when an operator supplies both
 * an exact Ed25519 root and the independently governed SHA-256 pin of that
 * root's canonical JSON. The isolated composition root/operator is the
 * authority: no route, job, ambient configuration, or untrusted caller may
 * control both values. Neither value is read from process state here.
 *
 * Source independence is an operational boundary, not a cryptographic
 * property of two public inputs. Therefore this function must remain private
 * to that isolated composition root; it is not a general caller-selected-root
 * verification API.
 */
export function createFixedTraceComponentSmokeOneShotGrantVerifier(
  trustRoot: unknown,
  expectedTrustRootPin: unknown,
): FixedTraceComponentSmokeOneShotGrantVerifier | null {
  const root = exactOneShotTrustRoot(trustRoot);
  if (!root || !hexDigest(expectedTrustRootPin)
    || createHash('sha256').update(canonicalJson(root), 'utf8').digest('hex') !== expectedTrustRootPin) return null;
  const registry = Object.freeze({ [root.kid]: root.spki });
  return Object.freeze({ verify: (value: unknown, now: Date) => verifyWithRegistry(value, now, registry, true) });
}

/** Production entry point: always fail-closed until its module-owned registry is provisioned. */
export function verifyFixedTraceComponentSmokeSignedGrant(value: unknown, now: Date): FixedTraceComponentSmokeVerifiedGrant | null {
  return verifyWithRegistry(value, now, PRODUCTION_SPKI_BY_KID, true);
}

/** Internal capability check used by the adjacent private ledger, never a boolean authorization API. */
export function isFixedTraceComponentSmokeVerifiedGrant(value: unknown): value is FixedTraceComponentSmokeVerifiedGrant {
  return typeof value === 'object' && value !== null && VERIFIED_GRANTS.has(value);
}

/** Returns only an irreversible digest; raw signatures never cross into the ledger. */
export function fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger(value: unknown): string | null {
  if (!isFixedTraceComponentSmokeVerifiedGrant(value)) return null;
  const signature = VERIFIED_GRANTS.get(value);
  return signature ? createHash('sha256').update(signature).digest('hex') : null;
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
  const verified = verifyWithRegistry(value, now, Object.freeze({ [testTrustRoot.kid]: spki.toString('base64url') }), false);
  return verified ? Object.freeze({ valid: true as const, signedPayloadDigest: verified.signedPayloadDigest }) : null;
}

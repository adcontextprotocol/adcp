import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY } from '../../../src/addie/eval/fixed-trace-component-smoke-private-authority.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM,
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION,
  fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger,
  fixedTraceComponentSmokeSignedGrantBytes,
  isFixedTraceComponentSmokeVerifiedGrant,
  verifyFixedTraceComponentSmokeSignedGrant,
  verifyFixedTraceComponentSmokeSignedGrantForTest,
  type FixedTraceComponentSmokeSignedGrantPayload,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-authorization.js';
import {
  PostgresFixedTraceComponentSmokePrivateLedger,
  fixedTraceComponentSmokePrivateLedgerPlan,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const TEST_KID = 'component-smoke-test-ed25519-2026';

function payload(overrides: Partial<FixedTraceComponentSmokeSignedGrantPayload> = {}): FixedTraceComponentSmokeSignedGrantPayload {
  return {
    grantVersion: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION, kid: TEST_KID,
    issuedAt: '2026-09-06T11:55:00.000Z', expiresAt: '2026-09-06T12:05:00.000Z',
    stageId: 'stage_1_smoke', admissionVersion: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.admissionVersion,
    aggregateAdmissionFingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint,
    cardinality: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.cardinality,
    reservationMicrodollars: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.reservationMicrodollars,
    providerCeilingMicrodollars: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.providerCeilingMicrodollars,
    pricingCohortDigest: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.pricingCohortDigest,
    nonceCommitment: 'a'.repeat(64), ...overrides,
  };
}
function grant(candidate = payload(), signature = sign(null, fixedTraceComponentSmokeSignedGrantBytes(candidate), keys.privateKey)) {
  return { algorithm: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM, payload: candidate, signature: signature.toString('base64url') };
}
function verify(value: unknown) { return verifyFixedTraceComponentSmokeSignedGrantForTest(value, NOW, { kid: TEST_KID, publicKey: keys.publicKey }); }
function deterministicReservationId(authorizationDigest: string) {
  return `reservation_${createHash('sha256').update(JSON.stringify({ authorizationDigest, domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0' }), 'utf8').digest('hex').slice(0, 32)}`;
}
function reservation(authorizationDigest = 'a'.repeat(64), reservationId = deterministicReservationId(authorizationDigest)) {
  return { authorizationDigest, reservationId, entryCount: 168 as const, providerDispatchEntryCount: 126 as const, reservationMicrodollars: 2_819_484 as const };
}

/** Deterministic in-process SQL fake; it has no socket, network, or provider path. */
class FakeLedgerClient {
  readonly calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  private readonly authorizations = new Map<string, string>();
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === "SET LOCAL lock_timeout = '250ms'" || sql === "SET LOCAL statement_timeout = '1000ms'" || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_authorizations')) {
      const digest = params?.[0] as string;
      if (this.authorizations.has(digest)) return { rowCount: 0, rows: [] };
      this.authorizations.set(digest, 'consumed');
      return { rowCount: 1, rows: [{ authorization_digest: digest }] };
    }
    if (sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_run_plan')) return { rowCount: 1, rows: [] };
    if (sql.startsWith('SELECT status, expires_at')) {
      const status = this.authorizations.get(params?.[0] as string);
      return status ? { rowCount: 1, rows: [{ status, expires_at: '2026-09-06T13:00:00.000Z' }] } : { rowCount: 0, rows: [] };
    }
    throw new Error(`unrecognised fake SQL: ${sql.slice(0, 80)}`);
  }
  release() {}
}

describe('fixed-trace component smoke private signed authorization', () => {
  it('verifies only an exact Ed25519 test grant; production stays unprovisioned', () => {
    const checked = verify(grant());
    expect(checked).toMatchObject({ valid: true });
    expect(checked).not.toHaveProperty('signature');
    const mutableEnvelope = grant();
    const verifiedBeforeMutation = verify(mutableEnvelope);
    mutableEnvelope.signature = 'A'.repeat(86);
    expect(verifiedBeforeMutation).toMatchObject({ valid: true });
    expect(verifyFixedTraceComponentSmokeSignedGrant(grant(), NOW)).toBeNull();
    expect(verify({ ...grant(), algorithm: 'ES256' })).toBeNull();
    expect(verify({ ...grant(), extra: true })).toBeNull();
    expect(verify({ ...grant(), payload: { ...payload(), extra: true } })).toBeNull();
    expect(verify(grant(payload({ kid: 'unknown-key' })))).toBeNull();
    expect(verify(grant(payload(), Buffer.alloc(64)))).toBeNull();
  });

  it('has no ambient root, issuer, private-key, or network construction dependency', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-authorization.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('readFile');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('createPrivateKey');
    expect(source).not.toContain('generateKeyPair');
    expect(source).not.toContain('createFixedTraceComponentSmokeOneShotGrantVerifier');
    expect(source).not.toContain('WeakMap');
  });

  it('keeps test crypto verification data-only and unable to authorize the ledger', () => {
    const checked = verify(grant());
    expect(checked).toMatchObject({ valid: true });
    expect(isFixedTraceComponentSmokeVerifiedGrant(checked)).toBe(false);
    expect(fixedTraceComponentSmokeVerifiedGrantSignatureDigestForLedger(checked)).toBeNull();
  });

  it.each([
    ['v1 admission', { admissionVersion: 'addie-fixed-trace-component-smoke-admission-v1' }],
    ['fingerprint drift', { aggregateAdmissionFingerprint: '0'.repeat(64) }],
    ['cardinality drift', { cardinality: { ...payload().cardinality, maximumProviderInvocations: 193 } }],
    ['cost drift', { reservationMicrodollars: 2_819_485 }],
    ['pricing drift', { pricingCohortDigest: '0'.repeat(64) }],
    ['future issue', { issuedAt: '2026-09-06T12:00:00.001Z' }],
    ['exact expiry', { expiresAt: '2026-09-06T12:00:00.000Z' }],
    ['excess lifetime', { expiresAt: '2026-09-06T12:10:00.001Z' }],
  ])('rejects %s before any ledger boundary', (_name, overrides) => {
    expect(verify(grant(payload(overrides)))).toBeNull();
  });

  it('derives the exact no-spend plan and retains no dispatch construction path', () => {
    const plan = fixedTraceComponentSmokePrivateLedgerPlan();
    expect(plan).toHaveLength(168);
    expect(plan?.filter((entry) => entry.disposition === 'provider_dispatch')).toHaveLength(126);
    expect(plan?.filter((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 1)).toHaveLength(60);
    expect(plan?.filter((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)).toHaveLength(66);
    expect(plan?.filter((entry) => entry.disposition !== 'provider_dispatch')).toHaveLength(42);
    expect(plan?.reduce((sum, entry) => sum + entry.maximumProviderInvocations, 0)).toBe(192);
    expect(plan?.reduce((sum, entry) => sum + entry.reservedMicrodollars.reduce((inner, micros) => inner + micros, 0), 0)).toBe(2_819_484);
    expect(plan?.filter((entry) => entry.disposition !== 'provider_dispatch').every((entry) => entry.maximumProviderInvocations === 0 && entry.reservedMicrodollars.length === 0)).toBe(true);
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('adapter.invoke');
    const migration = readFileSync(new URL('../../../src/db/migrations/582_addie_fixed_trace_component_smoke_private_ledger.sql', import.meta.url), 'utf8');
    expect(migration).toContain('UNIQUE (authorization_digest, assignment_id, invocation_ordinal)');
    expect(migration).toContain('invocation_ordinal BETWEEN 1 AND 2');
    expect(migration).toContain('provider_dispatch_assignments = 126');
    expect(migration).toContain('assignments = 168');
    expect(migration).toContain('signature_digest CHAR(64)');
    expect(migration).not.toContain('signature BYTEA');
    expect(source).toContain('pgSafeInt');
    expect(source).toContain('cacheReadTokens');
    expect(source).toContain("status = 'unknown_exposure'");
  });

  it('never turns a caller-selected test trust root into a ledger capability', async () => {
    const checked = verify(grant());
    if (!checked) throw new Error('expected test grant verification');
    const client = new FakeLedgerClient();
    const ledger = new PostgresFixedTraceComponentSmokePrivateLedger({ connect: async () => client } as never);
    await expect(ledger.reserveAndConsume(checked as never)).resolves.toEqual({ status: 'refused', reason: 'admission_drift' });
    expect(client.calls).toHaveLength(0);
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('from "../../db/client');
    expect(source).not.toContain('grantId');
    expect(source).not.toContain('apiKey');
    expect(source).not.toContain('prompt:');
    expect(source).not.toContain('output:');
  });

  it.each([
    ['wrong kid', grant(payload({ kid: 'wrong-kid' }))],
    ['wrong signature', grant(payload(), Buffer.alloc(64))],
    ['missing signature', { algorithm: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM, payload: payload() }],
    ['expired grant', grant(payload({ expiresAt: '2026-09-06T12:00:00.000Z' }))],
  ])('rejects %s before it can mint a capability', (_name, candidate) => {
    expect(verify(candidate)).toBeNull();
  });

  it('rejects a wrong or cross-reservation envelope before it can mutate a ledger', async () => {
    const client = new FakeLedgerClient();
    const ledger = new PostgresFixedTraceComponentSmokePrivateLedger({ connect: async () => client } as never);
    const wrong = reservation('a'.repeat(64), 'reservation_'.concat('0'.repeat(32)));
    const cross = reservation('a'.repeat(64), deterministicReservationId('b'.repeat(64)));
    await expect(ledger.recordUnknownExposure(wrong)).resolves.toEqual({ status: 'refused', reason: 'plan_mismatch' });
    await expect(ledger.recordProviderIntent({ reservation: cross, attemptId: `attempt_${'0'.repeat(32)}`, assignmentId: 'c'.repeat(64), invocationOrdinal: 1, preparedRequestHmac: 'd'.repeat(64) })).resolves.toEqual({ status: 'refused', reason: 'plan_mismatch' });
    expect(client.calls).toHaveLength(0);
  });
});

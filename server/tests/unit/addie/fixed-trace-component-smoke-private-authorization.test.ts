import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM,
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION,
  fixedTraceComponentSmokeSignedGrantBytes,
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
  const admission = fixedTraceComponentSmokeAdmission();
  if (!admission.pricing.cohortDigest || admission.pricing.reservationMicrodollars === null) throw new Error('expected pinned pricing');
  return {
    grantVersion: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION, kid: TEST_KID,
    issuedAt: '2026-09-06T11:00:00.000Z', expiresAt: '2026-09-06T13:00:00.000Z',
    stageId: 'stage_1_smoke', admissionVersion: admission.version,
    aggregateAdmissionFingerprint: admission.fingerprints.aggregateAdmission,
    cardinality: admission.cardinality, reservationMicrodollars: admission.pricing.reservationMicrodollars,
    providerCeilingMicrodollars: admission.pricing.providerCeilingUsd * 1_000_000,
    pricingCohortDigest: admission.pricing.cohortDigest,
    nonceCommitment: 'a'.repeat(64), ...overrides,
  };
}
function grant(candidate = payload(), signature = sign(null, fixedTraceComponentSmokeSignedGrantBytes(candidate), keys.privateKey)) {
  return { algorithm: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM, payload: candidate, signature: signature.toString('base64url') };
}
function verify(value: unknown) { return verifyFixedTraceComponentSmokeSignedGrantForTest(value, NOW, { kid: TEST_KID, publicKey: keys.publicKey }); }

/** Deterministic in-process SQL fake; it has no socket, network, or provider path. */
class FakeLedgerClient {
  readonly calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  private readonly authorizations = new Map<string, string>();
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_authorizations')) {
      const digest = params?.[0] as string;
      if (this.authorizations.has(digest)) return { rowCount: 0, rows: [] };
      this.authorizations.set(digest, 'consumed');
      return { rowCount: 1, rows: [{ authorization_digest: digest }] };
    }
    if (sql.startsWith('SELECT status, expires_at')) {
      const status = this.authorizations.get(params?.[0] as string);
      return status ? { rowCount: 1, rows: [{ status, expires_at: '2026-09-06T13:00:00.000Z' }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }
  release() {}
}

describe('fixed-trace component smoke private signed authorization', () => {
  it('verifies only an exact Ed25519 test grant; production stays unprovisioned', () => {
    expect(verify(grant())).toMatchObject({ payload: { kid: TEST_KID, stageId: 'stage_1_smoke' } });
    expect(verifyFixedTraceComponentSmokeSignedGrant(grant(), NOW)).toBeNull();
    expect(verify({ ...grant(), algorithm: 'ES256' })).toBeNull();
    expect(verify({ ...grant(), extra: true })).toBeNull();
    expect(verify({ ...grant(), payload: { ...payload(), extra: true } })).toBeNull();
    expect(verify(grant(payload({ kid: 'unknown-key' })))).toBeNull();
    expect(verify(grant(payload(), Buffer.alloc(64)))).toBeNull();
  });

  it.each([
    ['v1 admission', { admissionVersion: 'addie-fixed-trace-component-smoke-admission-v1' }],
    ['fingerprint drift', { aggregateAdmissionFingerprint: '0'.repeat(64) }],
    ['cardinality drift', { cardinality: { ...payload().cardinality, maximumProviderInvocations: 193 } }],
    ['cost drift', { reservationMicrodollars: 2_819_485 }],
    ['pricing drift', { pricingCohortDigest: '0'.repeat(64) }],
    ['future issue', { issuedAt: '2026-09-06T12:00:00.001Z' }],
    ['exact expiry', { expiresAt: '2026-09-06T12:00:00.000Z' }],
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
  });

  it('uses one checked-out-client transaction to atomically reserve the exact plan and reject a replay', async () => {
    const approved = verify(grant());
    if (!approved) throw new Error('expected test grant');
    const client = new FakeLedgerClient();
    const ledger = new PostgresFixedTraceComponentSmokePrivateLedger({ connect: async () => client } as never);
    const results = await Promise.all([ledger.reserveAndConsume(approved), ledger.reserveAndConsume(approved)]);
    expect(results.filter((entry) => entry.status === 'reserved')).toHaveLength(1);
    expect(results).toContainEqual({ status: 'refused', reason: 'grant_already_consumed' });
    expect(client.calls.filter((entry) => entry.sql.startsWith('INSERT INTO addie_fixed_trace_component_smoke_run_plan'))).toHaveLength(168);
    expect(client.calls.filter((entry) => entry.sql === 'BEGIN')).toHaveLength(2);
    expect(client.calls.filter((entry) => entry.sql === 'COMMIT')).toHaveLength(2);
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('from "../../db/client');
    expect(source).not.toContain('grantId');
    expect(source).not.toContain('apiKey');
    expect(source).not.toContain('prompt:');
    expect(source).not.toContain('output:');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION,
  FIXED_TRACE_COMPONENT_SMOKE_RUNTIME_DISABLED,
  FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID,
  InMemoryFixedTraceComponentSmokeExecutionLedger,
  fixedTraceComponentSmokeGrantIssuanceRequest,
  isFixedTraceComponentSmokeAuthorizationGrant,
  parseFixedTraceComponentSmokeIntentResult,
  parseFixedTraceComponentSmokeReserveResult,
  parseFixedTraceComponentSmokeTerminalResult,
  runFixedTraceComponentSmoke,
  type FixedTraceComponentSmokeAuthorizationGrant,
} from '../../../src/addie/eval/fixed-trace-component-smoke-execution.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const testClock = () => NOW;

function grant(overrides: Record<string, unknown> = {}): FixedTraceComponentSmokeAuthorizationGrant {
  const request = fixedTraceComponentSmokeGrantIssuanceRequest();
  if (!request) throw new Error('expected ready admission');
  return {
    version: FIXED_TRACE_COMPONENT_SMOKE_GRANT_VERSION,
    grantId: 'grant_0123456789abcdef0123456789abcdef',
    nonce: 'nonce_0123456789abcdef0123456789abcdef',
    issuedAt: '2026-09-06T11:00:00.000Z', expiresAt: '2026-09-06T13:00:00.000Z',
    binding: { stageId: request.stageId, aggregateAdmissionFingerprint: request.aggregateAdmissionFingerprint,
      cardinality: request.cardinality, pricing: request.pricing },
    ...overrides,
  } as FixedTraceComponentSmokeAuthorizationGrant;
}
function enabled() {
  return { mode: 'private_runtime_enabled' as const, stageId: FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID,
    aggregateAdmissionFingerprint: fixedTraceComponentSmokeAdmission().fingerprints.aggregateAdmission };
}
function attemptId(index: number) { return `attempt_${index.toString(16).padStart(32, '0')}`; }

describe('fixed-trace component-smoke private execution control', () => {
  it('has no authorization by default and hard-refuses before touching ledger or adapter', async () => {
    const invoke = vi.fn();
    const ledger = { durability: 'private_durable_atomic', reserveAndConsume: vi.fn(), recordAttemptIntent: vi.fn(), recordAttemptTerminal: vi.fn() };
    expect(fixedTraceComponentSmokeGrantIssuanceRequest()).toMatchObject({
      stageId: FIXED_TRACE_COMPONENT_SMOKE_STAGE_ID,
      cardinality: fixedTraceComponentSmokeAdmission().cardinality,
      pricing: fixedTraceComponentSmokeAdmission().pricing,
    });
    await expect(runFixedTraceComponentSmoke({ grant: undefined, now: NOW })).resolves.toEqual({ status: 'refused', reason: 'invalid_grant' });
    await expect(runFixedTraceComponentSmoke({ grant: grant(), adapter: { invoke }, runtimeEnablement: FIXED_TRACE_COMPONENT_SMOKE_RUNTIME_DISABLED, now: NOW })).resolves.toEqual({ status: 'refused', reason: 'runtime_not_enabled' });
    await expect(runFixedTraceComponentSmoke({ grant: grant(), ledger: ledger as never, adapter: { invoke }, runtimeEnablement: enabled(), now: NOW })).resolves.toEqual({ status: 'refused', reason: 'private_durable_runtime_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
    expect(ledger.reserveAndConsume).not.toHaveBeenCalled();
  });

  it('refuses a non-ready admission even when every other dispatch dependency is supplied', async () => {
    const invoke = vi.fn();
    const notReady = { ...structuredClone(fixedTraceComponentSmokeAdmission()), status: 'not_admitted' };
    await expect(runFixedTraceComponentSmoke({ grant: grant(), adapter: { invoke }, runtimeEnablement: enabled(), now: NOW,
      admission: notReady as ReturnType<typeof fixedTraceComponentSmokeAdmission> })).resolves.toEqual({ status: 'refused', reason: 'admission_not_ready' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', { nonce: 'short' }],
    ['expired', { expiresAt: '2026-09-06T12:00:00.000Z' }],
    ['future issued', { issuedAt: '2026-09-06T12:00:00.001Z' }],
    ['hostile grant id', { grantId: 'Authorization:Bearer_PRIVATE_GRANT_123' }],
    ['hostile nonce', { nonce: 'Bearer_PRIVATE_GRANT_123' }],
    ['stale fingerprint', { binding: { ...grant().binding, aggregateAdmissionFingerprint: '0'.repeat(64) } }],
    ['altered cardinality', { binding: { ...grant().binding, cardinality: { ...grant().binding.cardinality, maximumProviderInvocations: 257 } } }],
    ['altered reservation', { binding: { ...grant().binding, pricing: { ...grant().binding.pricing, maximumReservationUsd: 3.8 } } }],
  ])('rejects a %s grant before ledger mutation or adapter invocation', async (_name, overrides) => {
    const value = grant(overrides);
    const invoke = vi.fn();
    expect(isFixedTraceComponentSmokeAuthorizationGrant(value, fixedTraceComponentSmokeAdmission(), NOW)).toBe(false);
    await expect(runFixedTraceComponentSmoke({ grant: value, adapter: { invoke }, runtimeEnablement: enabled(), now: NOW })).resolves.toEqual({ status: 'refused', reason: 'invalid_grant' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    'sk-proj-0123456789abcdef0123456789abcdef',
    'sk-ant-api03-0123456789abcdef0123456789abcdef',
    'ghp_0123456789abcdef0123456789abcdef',
    'AKIA0123456789ABCDEF',
    'nonce_0123456789abcdef0123456789abcdef',
    'grant_0123456789abcdef0123456789abcde',
    'grant_0123456789abcdef0123456789abcdef0',
    'grant_0123456789ABCDEF0123456789ABCDEF',
  ])('rejects a non-grant issuer grammar in grantId: %s', (grantId) => {
    expect(isFixedTraceComponentSmokeAuthorizationGrant(grant({ grantId }), fixedTraceComponentSmokeAdmission(), NOW)).toBe(false);
  });

  it.each([
    'sk-proj-0123456789abcdef0123456789abcdef',
    'sk-ant-api03-0123456789abcdef0123456789abcdef',
    'ghp_0123456789abcdef0123456789abcdef',
    'AKIA0123456789ABCDEF',
    'grant_0123456789abcdef0123456789abcdef',
    'nonce_0123456789abcdef0123456789abcde',
    'nonce_0123456789abcdef0123456789abcdef0',
    'nonce_0123456789ABCDEF0123456789ABCDEF',
  ])('rejects a non-nonce issuer grammar in nonce: %s', (nonce) => {
    expect(isFixedTraceComponentSmokeAuthorizationGrant(grant({ nonce }), fixedTraceComponentSmokeAdmission(), NOW)).toBe(false);
  });

  it('atomically consumes once under concurrency and revalidates expiry against the ledger clock', async () => {
    const value = grant();
    const ledger = new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock);
    ledger.seedIssuedGrant(value);
    const results = await Promise.all([ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() }), ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() })]);
    expect(results.filter((result) => result.status === 'reserved')).toHaveLength(1);
    expect(results).toContainEqual({ status: 'refused', reason: 'grant_already_consumed' });
    const expiredClock = new InMemoryFixedTraceComponentSmokeExecutionLedger(() => new Date('2026-09-06T13:00:00.000Z'));
    expiredClock.seedIssuedGrant(grant());
    await expect(expiredClock.reserveAndConsume({ grant: grant(), admission: fixedTraceComponentSmokeAdmission() })).resolves.toEqual({ status: 'refused', reason: 'grant_not_active' });
    const futureGrant = grant({ issuedAt: '2026-09-06T12:00:00.001Z' });
    const futureClock = new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock);
    futureClock.seedIssuedGrant(futureGrant);
    await expect(futureClock.reserveAndConsume({ grant: futureGrant, admission: fixedTraceComponentSmokeAdmission() })).resolves.toEqual({ status: 'refused', reason: 'grant_not_active' });
  });

  it('reserves the exact admitted maximum and keeps grant handles out of general records', async () => {
    const value = grant();
    const ledger = new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock);
    ledger.seedIssuedGrant(value);
    const reserved = await ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() });
    if (reserved.status !== 'reserved') throw new Error('expected reservation');
    expect(reserved.reservation).toMatchObject({ maximumProviderInvocations: 192, maximumReservationUsd: 2.819484 });
    expect(reserved.reservation.maximumReservationUsd).toBe(2.819484);
    expect(reserved.reservation).not.toHaveProperty('grantId');
    for (let index = 0; index < 192; index += 1) {
      await expect(ledger.recordAttemptIntent({ reservation: reserved.reservation, attemptCorrelationId: attemptId(index), probeId: 'probe', cellId: 'cell', invocationOrdinal: 1 })).resolves.toEqual({ status: 'recorded' });
    }
    await expect(ledger.recordAttemptIntent({ reservation: reserved.reservation, attemptCorrelationId: attemptId(192), probeId: 'probe', cellId: 'cell', invocationOrdinal: 1 })).resolves.toEqual({ status: 'refused', reason: 'count_exhausted' });
    const stored = JSON.stringify(ledger.snapshotForTest());
    expect(ledger.snapshotForTest().consumedGrantCount).toBe(1);
    expect(stored).not.toContain(value.grantId);
    expect(stored).not.toContain(value.nonce);
    expect(stored).not.toContain('api_key');
  });

  it('refuses duplicate, corrupt, and crash-window attempts without retrying unknown work', async () => {
    const value = grant();
    const ledger = new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock);
    ledger.seedIssuedGrant(value);
    const reserved = await ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() });
    if (reserved.status !== 'reserved') throw new Error('expected reservation');
    const intent = { reservation: reserved.reservation, attemptCorrelationId: attemptId(1), probeId: 'probe', cellId: 'cell', invocationOrdinal: 1 };
    await expect(ledger.recordAttemptIntent(intent)).resolves.toEqual({ status: 'recorded' });
    await expect(ledger.recordAttemptIntent(intent)).resolves.toEqual({ status: 'refused', reason: 'duplicate_attempt_id' });
    await expect(ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() })).resolves.toEqual({ status: 'refused', reason: 'unknown_attempt_exists' });
    await expect(ledger.recordAttemptTerminal({ reservation: reserved.reservation, attemptCorrelationId: attemptId(2), outcome: 'succeeded' })).resolves.toEqual({ status: 'refused', reason: 'admission_drift' });
  });

  it('records only categorical provider outcomes and refuses payload leakage', async () => {
    const value = grant();
    const ledger = new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock);
    ledger.seedIssuedGrant(value);
    const reserved = await ledger.reserveAndConsume({ grant: value, admission: fixedTraceComponentSmokeAdmission() });
    if (reserved.status !== 'reserved') throw new Error('expected reservation');
    const intent = { reservation: reserved.reservation, attemptCorrelationId: attemptId(3), probeId: 'probe', cellId: 'cell', invocationOrdinal: 1 };
    await ledger.recordAttemptIntent(intent);
    await expect(ledger.recordAttemptTerminal({ reservation: intent.reservation, attemptCorrelationId: intent.attemptCorrelationId, outcome: 'provider_failed' })).resolves.toEqual({ status: 'recorded' });
    await expect(ledger.recordAttemptIntent({ ...intent, attemptCorrelationId: attemptId(4), prompt: 'private full prompt', apiKey: 'secret' } as never)).resolves.toEqual({ status: 'refused', reason: 'admission_drift' });
    await expect(ledger.recordAttemptTerminal({ reservation: intent.reservation, attemptCorrelationId: attemptId(4), outcome: 'succeeded', output: 'private full output' } as never)).resolves.toEqual({ status: 'refused', reason: 'admission_drift' });
    expect(ledger.snapshotForTest().terminals).toMatchObject([{ outcome: 'provider_failed' }]);
  });

  it.each([
    ['null', null],
    ['proxy', new Proxy({ status: 'recorded' }, {})],
    ['throwing proxy', new Proxy({}, { ownKeys: () => { throw new Error('trap'); } })],
    ['partial success', { status: 'recorded', extra: true }],
    ['extra-key success', { status: 'recorded', ignored: true }],
    ['arbitrary refusal', { status: 'refused', reason: 'forged' }],
  ])('fails closed for hostile intent and terminal ledger result: %s', (_name, result) => {
    expect(parseFixedTraceComponentSmokeIntentResult(result)).toBeNull();
    expect(parseFixedTraceComponentSmokeTerminalResult(result)).toBeNull();
  });

  it.each([
    ['null', null],
    ['proxy', new Proxy({ status: 'reserved', reservation: {} }, {})],
    ['throwing proxy', new Proxy({}, { ownKeys: () => { throw new Error('trap'); } })],
    ['partial success', { status: 'reserved' }],
    ['extra-key success', { status: 'reserved', reservation: {}, ignored: true }],
    ['arbitrary refusal', { status: 'refused', reason: 'forged' }],
  ])('fails closed for hostile reserve ledger result: %s', (_name, result) => {
    expect(parseFixedTraceComponentSmokeReserveResult(result)).toBeNull();
  });

  it('accepts only exact known ledger response shapes and contains no ambient paid-run path', () => {
    expect(parseFixedTraceComponentSmokeReserveResult({ status: 'refused', reason: 'grant_not_active' })).toEqual({ status: 'refused', reason: 'grant_not_active' });
    expect(parseFixedTraceComponentSmokeIntentResult({ status: 'recorded' })).toEqual({ status: 'recorded' });
    expect(parseFixedTraceComponentSmokeTerminalResult({ status: 'recorded' })).toEqual({ status: 'recorded' });
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-execution.ts', import.meta.url), 'utf8');
    expect(new InMemoryFixedTraceComponentSmokeExecutionLedger(testClock).durability).toBe('test_memory_only');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('fixed-trace-runner');
  });
});

import { describe, expect, it } from 'vitest';
import { FIXED_TRACE_EXPERIMENT_PLAN_VERSION, estimateFixedTraceExperiment, fixedTraceCandidatePlanFingerprint, fixedTraceExperimentPlanFingerprint, fixedTraceTrustedManifestFingerprint, validateFixedTraceExperimentPlanOffline, validateFixedTraceRawAuditableLedgerOffline, type FixedTraceExperimentPlan } from '../../../src/addie/eval/fixed-trace-experiment-plan.js';
import { FIXED_TRACE_PARTITION_MANIFEST, FIXED_TRACE_PARTITION_MANIFEST_SHA256, FIXED_TRACE_PARTITION_MANIFEST_VERSION } from '../../../src/addie/eval/fixed-trace-partition.js';
import { CLAUDE_PRICING_VERSION } from '../../../src/addie/claude-pricing.js';
import { CODE_VERSION } from '../../../src/addie/config-version.js';
import { FIXED_TRACE_STAGE_CONTROL_VERSION, FIXED_TRACE_SUITE } from '../../../src/addie/eval/fixed-trace-suite.js';

const HASH = 'a'.repeat(64);
function plan(): FixedTraceExperimentPlan {
  const inputBytesByTrace = Object.fromEntries(FIXED_TRACE_PARTITION_MANIFEST.development.map((id) => [id, [100]]));
  return { version: FIXED_TRACE_EXPERIMENT_PLAN_VERSION, id: 'offline-v1', trustedManifestId: 'unissued', sourceId: 'fixture', sourceRevision: 'v1', pricingAsOf: '2026-09-05T12:00:00.000Z', sourceBundleSha256: HASH, gitCommit: 'a'.repeat(40), gitDirty: false, addieCodeVersion: CODE_VERSION, stageControlVersion: FIXED_TRACE_STAGE_CONTROL_VERSION, traceSuiteSha256: HASH, promptConfigVersion: HASH, toolSchemaSha256: HASH, toolDefinitionProvenance: 'fixture_local', providerDegradationInjectionEnabled: true, partition: { manifestVersion: FIXED_TRACE_PARTITION_MANIFEST_VERSION, manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256, selected: 'development' }, ordering: { seed: 'seed' }, budgets: { candidateCeilingUsd: 1, judgeCeilingUsd: 1 }, arms: [{ id: 'router-r1', architecture: 'two_stage_llm_router', screeningStage: 'router_only_screen', repetitionIndex: 1, router: { provider: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'provider_default', pricingVersion: CLAUDE_PRICING_VERSION, maxOutputTokens: 10, timeoutMs: 1_000, maxIterations: 1, transportRetries: 0, samplingMode: 'provider_no_sampling_control', temperature: null, cacheMode: 'disabled', requestBounds: { inputBytesByTrace } } }] };
}

describe('fixed-trace experiment plan offline boundary', () => {
  it('is diagnostic only and has no trust or dispatch lock', () => {
    expect(validateFixedTraceExperimentPlanOffline(plan())).toMatchObject({ diagnosticOnly: true, comparisonEligible: false, dispatchable: false, trustedLock: false });
  });
  it('rejects inherited, accessor, proxy, extra-field, and unpriced Terra input', () => {
    const inherited = Object.assign(Object.create(plan()), { version: FIXED_TRACE_EXPERIMENT_PLAN_VERSION });
    expect(() => validateFixedTraceExperimentPlanOffline(inherited)).toThrow('plain object');
    const getter = plan(); Object.defineProperty(getter, 'id', { enumerable: true, get: () => 'getter' });
    expect(() => validateFixedTraceExperimentPlanOffline(getter)).toThrow('own enumerable data');
    expect(() => validateFixedTraceExperimentPlanOffline(new Proxy(plan(), {}))).toThrow('Proxy');
    const extra = plan() as FixedTraceExperimentPlan & { extra: boolean }; extra.extra = true;
    expect(() => validateFixedTraceExperimentPlanOffline(extra)).toThrow('unknown');
    const terra = plan(); terra.arms[0].router!.model = 'gpt-5.6-terra';
    expect(() => validateFixedTraceExperimentPlanOffline(terra)).toThrow('Unavailable immutable pricing');
  });
  it('does not lose prototype-pollution keys at plan and raw-ledger boundaries', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const hostile = plan() as any;
      Object.defineProperty(hostile, key, { enumerable: true, value: { poisoned: true } });
      expect(() => fixedTraceExperimentPlanFingerprint(hostile, () => null)).toThrow('dangerous prototype key');
      expect(() => fixedTraceCandidatePlanFingerprint(hostile)).toThrow('dangerous prototype key');
    }
    const manifest = { id: 'clean' } as any;
    const hostileManifest = { id: 'clean' } as any;
    Object.defineProperty(hostileManifest, '__proto__', { enumerable: true, value: { poisoned: true } });
    expect(fixedTraceTrustedManifestFingerprint(hostileManifest))
      .not.toBe(fixedTraceTrustedManifestFingerprint(manifest));
  });
  it('does not invoke a hostile getter before rejecting it, and detaches estimates', () => {
    const hostile = plan() as any;
    let reads = 0;
    Object.defineProperty(hostile, 'id', { enumerable: true, get() { reads += 1; return 'forged'; } });
    expect(() => validateFixedTraceExperimentPlanOffline(hostile)).toThrow('own enumerable data');
    expect(reads).toBe(0);
    const mutable = plan();
    const estimate = estimateFixedTraceExperiment(mutable, () => null);
    mutable.arms[0].router!.maxOutputTokens = 999;
    expect(estimate.candidate.reservations[0]?.outputTokens).toBe(FIXED_TRACE_PARTITION_MANIFEST.development.length * 10);
    expect(Object.isFrozen(estimate.candidate.reservations)).toBe(true);
    (mutable.arms as any).extra = true;
    expect(() => validateFixedTraceExperimentPlanOffline(mutable)).toThrow('extra array property');
  });
  it('requires exact ledger sequence, tools, and offline provider resolution', () => {
    const current = plan();
    const entries = FIXED_TRACE_PARTITION_MANIFEST.development.map((traceId, index) => ({ sequence: index + 1, phaseId: 'router_only_screen' as const, armId: 'router-r1', repetitionIndex: 1, traceId, stage: 'router' as const, callIndex: 1 as const, dispatched: false, requestedProvider: 'anthropic' as const, requestedModel: 'claude-haiku-4-5', returnedProvider: null, returnedModel: null, promptSha256: HASH, providerRequestSha256: null, responseSha256: null, rawRequestArtifact: null, rawResponseArtifact: null, exactToolNames: FIXED_TRACE_SUITE.find((item) => item.id === traceId)!.toolFixtures.map((fixture) => fixture.name), caseControlSha256: HASH, executionEnvelopeSha256: HASH, directAdmissionSha256: HASH, maxOutputTokens: 10, timeoutMs: 1_000, maxIterations: 1, transportRetries: 0 as const, reasoningEffort: 'provider_default' as const, samplingMode: 'provider_no_sampling_control' as const, cacheMode: 'disabled' as const, status: 'not_dispatched' as const, finishReason: null, usage: null, estimatedCostUsd: null }));
    const ledger = { version: 'addie-fixed-trace-raw-ledger-v1' as const, trustedManifestSha256: HASH, planFingerprint: validateFixedTraceExperimentPlanOffline(current).planFingerprint, budgetIdentitySha256: estimateFixedTraceExperiment(current, () => null).budgetIdentitySha256, entries };
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, ledger, HASH)).not.toThrow();
    const hostileLedger = { ...ledger } as any;
    Object.defineProperty(hostileLedger, '__proto__', { enumerable: true, value: { poisoned: true } });
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, hostileLedger, HASH)).toThrow('dangerous prototype key');
    ledger.entries[1].sequence = 1;
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, ledger, HASH)).toThrow('sequence');
    ledger.entries[1].sequence = 2; ledger.entries[0].exactToolNames = ['tampered'];
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, ledger, HASH)).toThrow('tool names');
    ledger.entries[0].exactToolNames = FIXED_TRACE_SUITE.find((item) => item.id === ledger.entries[0].traceId)!.toolFixtures.map((fixture) => fixture.name); ledger.entries[0].returnedProvider = 'google'; ledger.entries[0].returnedModel = 'gemini-3.7-flash';
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, ledger, HASH)).toThrow('dispatch, response');
    ledger.entries[0].returnedProvider = null; ledger.entries[0].returnedModel = null;
    ledger.trustedManifestSha256 = 'b'.repeat(64);
    expect(() => validateFixedTraceRawAuditableLedgerOffline(current, ledger, HASH)).toThrow('trusted manifest mismatch');
  });
});

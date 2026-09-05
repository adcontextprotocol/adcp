import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_EXPERIMENT_PLAN_VERSION,
  FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION,
  estimateFixedTraceExperiment,
  fixedTraceExperimentExecutionOrder,
  fixedTraceExperimentPartitionAudit,
  fixedTraceCandidatePlanFingerprint,
  fixedTraceDevelopmentSelectionArtifact,
  consumeFixedTraceHoldoutFinalization,
  fixedTraceExperimentPlanFingerprint,
  assertFixedTraceRawAuditableLedger,
  type FixedTraceExperimentPlan,
  type FixedTracePlannedStage,
} from '../../../src/addie/eval/fixed-trace-experiment-plan.js';
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  FIXED_TRACE_PARTITION_MANIFEST_VERSION,
} from '../../../src/addie/eval/fixed-trace-partition.js';
import { CLAUDE_PRICING_VERSION } from '../../../src/addie/claude-pricing.js';
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  OPENAI_GPT_5_6_PRICING_VERSION,
} from '../../../src/addie/model-cost-pricing.js';

const HASH = 'a'.repeat(64);

const trustedManifest = {
  id: 'trusted-synthetic-v1',
  sourceId: 'fixed-trace-synthetic-corpus',
  sourceRevision: 'addie-fixed-traces-v32',
  sourceBundleSha256: HASH,
  traceSuiteSha256: HASH,
  promptConfigVersion: HASH,
  toolSchemaSha256: HASH,
  partitionManifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  rawLedgerVersion: 'addie-fixed-trace-raw-ledger-v1' as const,
};
const resolver = (id: string) => id === trustedManifest.id ? trustedManifest : null;

function stage(
  provider: FixedTracePlannedStage['provider'],
  model: string,
  pricingVersion: string,
  maxIterations = 1,
  traceIds = FIXED_TRACE_PARTITION_MANIFEST.development,
): FixedTracePlannedStage {
  return {
    provider,
    model,
    pricingVersion,
    reasoningEffort: 'none',
    maxOutputTokens: 10,
    timeoutMs: 1_000,
    maxIterations,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    requestBounds: { inputBytesByTrace: Object.fromEntries(traceIds.map((id) => [id, Array(maxIterations).fill(100)])) },
  };
}

function plan(overrides: Partial<FixedTraceExperimentPlan> = {}): FixedTraceExperimentPlan {
  const router = stage('openai', 'gpt-5.6-luna', OPENAI_GPT_5_6_PRICING_VERSION);
  const generation = stage('openai', 'gpt-5.6-terra', OPENAI_GPT_5_6_PRICING_VERSION, 2);
  return {
    version: FIXED_TRACE_EXPERIMENT_PLAN_VERSION,
    id: 'matrix-v1',
    trustedManifestId: trustedManifest.id,
    sourceId: trustedManifest.sourceId,
    sourceRevision: trustedManifest.sourceRevision,
    pricingAsOf: '2026-09-05T12:00:00.000Z',
    sourceBundleSha256: HASH,
    traceSuiteSha256: HASH,
    promptConfigVersion: HASH,
    toolSchemaSha256: HASH,
    partition: {
      manifestVersion: FIXED_TRACE_PARTITION_MANIFEST_VERSION,
      manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
      selected: 'development',
    },
    ordering: { seed: 'recorded-seed-v1' },
    budgets: { candidateCeilingUsd: 1, judgeCeilingUsd: 1 },
    arms: [{
      id: 'terra-finalist-r1',
      architecture: 'two_stage_llm_router',
      screeningStage: 'deployable_finalist',
      repetitionIndex: 1,
      router,
      generation,
      judges: [
        { ...stage('anthropic', 'claude-sonnet-5', CLAUDE_PRICING_VERSION), blinded: true },
        { ...stage('google', 'gemini-3.7-flash', GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION), blinded: true },
      ],
    }],
    ...overrides,
  };
}

describe('fixed-trace experiment plan', () => {
  it('estimates a pure conservative ceiling with independently budgeted judges', () => {
    const estimate = estimateFixedTraceExperiment(plan(), resolver);
    expect(estimate.expectedSpendUsd).toBeNull();
    expect(estimate.candidate.expectedSpendUsd).toBeNull();
    expect(estimate.judges.expectedSpendUsd).toBeNull();
    expect(estimate.candidate.reservations.map((item) => item.stage)).toEqual(['router', 'generation']);
    expect(estimate.judges.reservations.map((item) => item.stage)).toEqual(['judge', 'judge']);
    expect(estimate.totalCeilingUsd).toBe(estimate.candidate.ceilingUsd + estimate.judges.ceilingUsd);
    expect(estimate.candidate.reservations[1]).toMatchObject({ requests: 48, inputBytes: 4_800, outputTokens: 480 });
  });

  it('fails closed for spoofed manifests, unknown pricing, and missing request bounds', () => {
    expect(() => fixedTraceExperimentPlanFingerprint(plan({
      partition: { manifestVersion: FIXED_TRACE_PARTITION_MANIFEST_VERSION, manifestSha256: HASH, selected: 'development' },
    }), resolver)).toThrow('uncommitted fixed-trace partition manifest');
    const unknown = plan();
    unknown.arms[0].router!.pricingVersion = 'price-i-made-up';
    expect(() => fixedTraceExperimentPlanFingerprint(unknown, resolver)).toThrow('Unavailable immutable pricing');
    const missing = plan();
    delete missing.arms[0].router!.requestBounds.inputBytesByTrace['surface-channel-chatter'];
    expect(() => fixedTraceExperimentPlanFingerprint(missing, resolver)).toThrow('exact bounds');
  });

  it('keeps holdout locked unless an explicit versioned finalization gate is present', () => {
    const holdout = plan({
      partition: { manifestVersion: FIXED_TRACE_PARTITION_MANIFEST_VERSION, manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256, selected: 'holdout' },
    });
    for (const item of holdout.arms) {
      if (item.router) item.router.requestBounds = { inputBytesByTrace: Object.fromEntries(FIXED_TRACE_PARTITION_MANIFEST.holdout.map((id) => [id, [100]])) };
      if (item.generation) item.generation.requestBounds = { inputBytesByTrace: Object.fromEntries(FIXED_TRACE_PARTITION_MANIFEST.holdout.map((id) => [id, [100, 100]])) };
      for (const judge of item.judges ?? []) judge.requestBounds = { inputBytesByTrace: Object.fromEntries(FIXED_TRACE_PARTITION_MANIFEST.holdout.map((id) => [id, [100]])) };
    }
    expect(() => fixedTraceExperimentPlanFingerprint(holdout, resolver)).toThrow('Holdout is locked');
    holdout.partition.finalizationGate = { version: FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION, recordId: 'finalization-1' };
    const finalization = {
      id: 'finalization-1', version: FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION,
      trustedManifestId: trustedManifest.id, frozenCandidatePlanFingerprint: fixedTraceCandidatePlanFingerprint(holdout),
      consumed: false, tracePackVisibility: 'repository_visible' as const,
    };
    const finalizationResolver = (id: string) => id === finalization.id ? finalization : null;
    expect(fixedTraceExperimentPartitionAudit(holdout, resolver, finalizationResolver)).toMatchObject({
      selected: 'holdout', manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
    });
    expect(() => fixedTraceDevelopmentSelectionArtifact(holdout, resolver)).toThrow('finalization record');
    let consumed = false;
    consumeFixedTraceHoldoutFinalization(holdout, resolver, finalizationResolver, (id, fingerprint) => {
      consumed = id === finalization.id && fingerprint === finalization.frozenCandidatePlanFingerprint;
      return consumed;
    });
    expect(consumed).toBe(true);
    holdout.arms[0].generation!.maxOutputTokens++;
    expect(() => fixedTraceExperimentPartitionAudit(holdout, resolver, finalizationResolver)).toThrow('frozen candidate plan');
    holdout.arms[0].generation!.maxOutputTokens--;
    finalization.consumed = true;
    expect(() => fixedTraceExperimentPartitionAudit(holdout, resolver, finalizationResolver)).toThrow('already been consumed');
  });

  it('rejects candidate self-judging, insufficient judges, duplicate arms, and unimplemented architectures', () => {
    const selfJudge = plan();
    selfJudge.arms[0].judges![0] = { ...stage('openai', 'gpt-5.6-sol', OPENAI_GPT_5_6_PRICING_VERSION), blinded: true };
    expect(() => fixedTraceExperimentPlanFingerprint(selfJudge, resolver)).toThrow('not provider-independent');
    const duplicate = plan();
    duplicate.arms = [...duplicate.arms, structuredClone(duplicate.arms[0])];
    expect(() => fixedTraceExperimentPlanFingerprint(duplicate, resolver)).toThrow('Duplicate experiment arm ID');
    const direct = plan();
    direct.arms[0].architecture = 'direct_generation';
    expect(() => fixedTraceExperimentPlanFingerprint(direct, resolver)).toThrow('inadmissible');
    const hybrid = plan();
    hybrid.arms[0].architecture = 'hybrid_generation';
    expect(() => fixedTraceExperimentPlanFingerprint(hybrid, resolver)).toThrow('inadmissible');
  });

  it('rejects a ceiling that under-reserves either candidate or judge work', () => {
    const candidate = plan({ budgets: { candidateCeilingUsd: 0.000001, judgeCeilingUsd: 1 } });
    expect(() => estimateFixedTraceExperiment(candidate, resolver)).toThrow('Candidate worst-case');
    const judges = plan({ budgets: { candidateCeilingUsd: 1, judgeCeilingUsd: 0.000001 } });
    expect(() => estimateFixedTraceExperiment(judges, resolver)).toThrow('Judge worst-case');
  });

  it('records a seed-based order and fingerprints every material control', () => {
    const repeated = plan();
    repeated.arms = ['luna', 'terra', 'sol'].map((name, index) => ({
      id: `${name}-router-r${index + 1}`,
      architecture: 'two_stage_llm_router' as const,
      screeningStage: 'router_only_screen' as const,
      repetitionIndex: index + 1,
      router: stage('openai', `gpt-5.6-${name}`, OPENAI_GPT_5_6_PRICING_VERSION),
    }));
    const first = fixedTraceExperimentExecutionOrder(repeated, resolver);
    expect(first).toEqual(fixedTraceExperimentExecutionOrder(structuredClone(repeated), resolver));
    repeated.ordering.seed = 'a different recorded seed';
    expect(fixedTraceExperimentExecutionOrder(repeated, resolver)).not.toEqual(first);
    const baseline = fixedTraceExperimentPlanFingerprint(plan(), resolver);
    const changed = plan();
    changed.arms[0].generation!.timeoutMs++;
    expect(fixedTraceExperimentPlanFingerprint(changed, resolver)).not.toBe(baseline);
    expect(fixedTraceDevelopmentSelectionArtifact(plan(), resolver)).toMatchObject({
      holdoutMetricsIncluded: false,
      blindingLimitation: 'execution_locked_repository_visible_not_secret_holdout',
    });
  });

  it('requires externally resolved trusted inputs and raw, identity-complete ledger entries', () => {
    expect(() => estimateFixedTraceExperiment(plan(), () => null)).toThrow('Trusted fixed-trace manifest is unavailable');
    const current = plan();
    const fingerprint = fixedTraceExperimentPlanFingerprint(current, resolver);
    const ledger = {
      version: 'addie-fixed-trace-raw-ledger-v1' as const,
      trustedManifestSha256: 'b'.repeat(64),
      planFingerprint: fingerprint,
      entries: [],
    };
    expect(() => assertFixedTraceRawAuditableLedger(current, resolver, ledger, () => null)).toThrow('trusted manifest mismatch');
    ledger.trustedManifestSha256 = '5be1abed816962f0b01f28eaf24f22058d5177f1dc4bcd9649cbe9eb77daaf85';
    expect(() => assertFixedTraceRawAuditableLedger(current, resolver, ledger, () => null)).toThrow('lacks complete planned-stage coverage');
  });
});

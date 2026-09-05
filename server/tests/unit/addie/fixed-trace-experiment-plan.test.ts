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
  fixedTraceExperimentRunnerBinding,
  fixedTraceTrustedManifestFingerprint,
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
import { CODE_VERSION } from '../../../src/addie/config-version.js';
import { canonicalFixedTraceToolDefinitions } from '../../../src/addie/eval/fixed-trace-tools.js';
import {
  FIXED_TRACE_STAGE_CONTROL_VERSION,
  FIXED_TRACE_SUITE,
  fixedTraceSuiteSha256,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import { fixedTraceToolSchemaSha256 } from '../../../src/addie/eval/fixed-trace-runner.js';

const HASH = 'a'.repeat(64);

function trustedSuite(ids: readonly string[]) {
  const traceSuite = FIXED_TRACE_SUITE.filter((trace) => ids.includes(trace.id));
  const fixtureNames = new Set(traceSuite.flatMap((trace) => trace.toolFixtures.map((fixture) => fixture.name)));
  const toolDefinitions = canonicalFixedTraceToolDefinitions().filter((definition) => fixtureNames.has(definition.name));
  return {
    traceSuite,
    traceSuiteSha256: fixedTraceSuiteSha256(traceSuite),
    toolDefinitions,
    toolSchemaSha256: fixedTraceToolSchemaSha256(traceSuite, toolDefinitions),
    toolDefinitionProvenance: 'fixture_local' as const,
  };
}

const trustedManifest = {
  id: 'trusted-synthetic-v1',
  sourceId: 'fixed-trace-synthetic-corpus',
  sourceRevision: 'addie-fixed-traces-v32',
  sourceBundleSha256: HASH,
  promptConfigVersion: HASH,
  suites: {
    development: trustedSuite(FIXED_TRACE_PARTITION_MANIFEST.development),
    holdout: trustedSuite(FIXED_TRACE_PARTITION_MANIFEST.holdout),
  },
  partitionManifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  rawLedgerVersion: 'addie-fixed-trace-raw-ledger-v1' as const,
  gitCommit: 'a'.repeat(40),
  gitDirty: false,
  addieCodeVersion: CODE_VERSION,
  stageControlVersion: FIXED_TRACE_STAGE_CONTROL_VERSION,
  providerDegradationInjectionEnabled: true,
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
    transportRetries: 0,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    cacheMode: 'disabled',
    requestBounds: { inputBytesByTrace: Object.fromEntries(traceIds.map((id) => [id, Array(maxIterations).fill(100)])) },
  };
}

function plan(overrides: Partial<FixedTraceExperimentPlan> = {}): FixedTraceExperimentPlan {
  const selected = overrides.partition?.selected ?? 'development';
  const suite = trustedManifest.suites[selected];
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
    gitCommit: trustedManifest.gitCommit,
    gitDirty: trustedManifest.gitDirty,
    addieCodeVersion: trustedManifest.addieCodeVersion,
    traceSuiteSha256: suite.traceSuiteSha256,
    promptConfigVersion: HASH,
    toolSchemaSha256: suite.toolSchemaSha256,
    toolDefinitionProvenance: suite.toolDefinitionProvenance,
    stageControlVersion: trustedManifest.stageControlVersion,
    providerDegradationInjectionEnabled: trustedManifest.providerDegradationInjectionEnabled,
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
    expect(estimate).toMatchObject({ diagnosticOnly: true, comparisonEligible: false });
    expect(estimate.expectedSpendUsd).toBeNull();
    expect(estimate.candidate.expectedSpendUsd).toBeNull();
    expect(estimate.judges.expectedSpendUsd).toBeNull();
    expect(estimate.candidate.reservations.map((item) => item.stage)).toEqual(['router', 'generation']);
    expect(estimate.judges.reservations.map((item) => item.stage)).toEqual(['judge', 'judge']);
    expect(estimate.totalCeilingUsd).toBe(estimate.candidate.ceilingUsd + estimate.judges.ceilingUsd);
    expect(estimate.candidate.reservations[1]).toMatchObject({ requests: 48, inputBytes: 4_800, outputTokens: 480 });
    expect(estimate.budgetIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes the frozen evaluator-owned suite and provenance unchanged to a future runner', () => {
    const current = plan();
    const binding = fixedTraceExperimentRunnerBinding(current, resolver, 'terra-finalist-r1');
    expect(binding).toMatchObject({
      runId: 'matrix-v1:terra-finalist-r1:r1',
      traceSuiteSha256: current.traceSuiteSha256,
      toolDefinitionProvenance: 'fixture_local',
      providerDegradationInjectionEnabled: true,
    });
    expect(Object.isFrozen(binding.traceSuite)).toBe(true);
    expect(Object.isFrozen(binding.traceSuite[0])).toBe(true);
    expect(Object.isFrozen(binding.toolDefinitions)).toBe(true);
    expect(Object.isFrozen(binding.toolDefinitions[0])).toBe(true);

    const forged = structuredClone(trustedManifest);
    forged.suites.development.traceSuite[0]!.id = 'forged-trace';
    expect(() => fixedTraceExperimentRunnerBinding(current, (id) => id === forged.id ? forged : null, 'terra-finalist-r1'))
      .toThrow('suite does not exactly bind');
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
      budgetIdentitySha256: estimateFixedTraceExperiment(current, resolver).budgetIdentitySha256,
      entries: [],
    };
    expect(() => assertFixedTraceRawAuditableLedger(current, resolver, ledger, () => null)).toThrow('trusted manifest mismatch');
    ledger.trustedManifestSha256 = fixedTraceTrustedManifestFingerprint(trustedManifest);
    expect(() => assertFixedTraceRawAuditableLedger(current, resolver, ledger, () => null)).toThrow('lacks complete planned-stage coverage');
  });
});

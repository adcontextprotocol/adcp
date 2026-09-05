import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import {
  runFixedTraceDiagnosticArtifact,
  type FixedTraceDiagnosticProviderPlan,
} from '../../../src/addie/eval/fixed-trace-diagnostic-run.js';
import { reserveFixedTraceDiagnosticOutput } from '../../../src/addie/eval/fixed-trace-diagnostic-output.js';
import type { FixedTraceProviderStageConfig } from '../../../src/addie/eval/fixed-trace-runner.js';
import {
  FIXED_TRACE_SUITE,
  fixedTraceSuiteSha256,
  type FixedTracePricing,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelProviderId,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: ['none'],
  customTools: true,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

const PRICING: FixedTracePricing = {
  profileId: 'synthetic-manual-artifact-v1',
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  cacheReadUsdPerMillionTokens: null,
  cacheWriteUsdPerMillionTokens: null,
  cacheReadAccounting: 'unsupported',
  cacheWriteAccounting: 'unsupported',
  source: 'Synthetic manual artifact pricing.',
};

function scriptedRouter(
  afterFinalResponse?: () => void,
  providerId: ModelProviderId = 'anthropic',
): { provider: ModelProvider; calls: ModelRequest[]; response: ModelResponse } {
  const calls: ModelRequest[] = [];
  const response: ModelResponse = {
    provider: providerId,
    model: 'synthetic-manual-model',
    id: `${providerId}-scripted-router-ignore`,
    content: [{ type: 'text', text: JSON.stringify({ action: 'ignore', reason: 'Synthetic route.' }) }],
    finishReason: 'stop',
    providerFinishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const provider: ModelProvider = {
    id: providerId,
    capabilities: CAPABILITIES,
    prepare(request: ModelRequest): PreparedModelInvocation {
      return {
        provider: providerId,
        model: request.model,
        capabilities: CAPABILITIES,
        requestMetadata: request.requestMetadata,
        providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
      };
    },
    async *respond(request: ModelRequest, options: ModelRespondOptions = {}): AsyncIterable<NormalizedModelEvent> {
      await options.beforeDispatch?.(this.prepare(request));
      calls.push(structuredClone(request));
      yield { type: 'response_start', provider: providerId, model: response.model, id: response.id };
      yield { type: 'text_delta', index: 0, text: response.content[0].type === 'text' ? response.content[0].text : '' };
      yield { type: 'response_complete', response };
      afterFinalResponse?.();
    },
  };
  return { provider, calls, response };
}

function stage(provider: ModelProvider): FixedTraceProviderStageConfig {
  return {
    provider,
    model: 'synthetic-manual-model',
    reasoningEffort: 'none',
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations: 1,
    transportRetries: 0,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing: structuredClone(PRICING),
  };
}

function budgetedStage(provider: ModelProvider, budget: FixedTraceBudget): FixedTraceProviderStageConfig {
  return stage(new BudgetedFixedTraceProvider(provider, budget, PRICING, () => true));
}

describe('fixed-trace diagnostic output reservation', () => {
  it('never overwrites an existing artifact', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    writeFileSync(path, 'existing');
    expect(() => reserveFixedTraceDiagnosticOutput(path)).toThrow('Cannot exclusively reserve');
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('rejects directory and missing-parent targets before dispatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    expect(() => reserveFixedTraceDiagnosticOutput(directory)).toThrow('Cannot exclusively reserve');
    expect(() => reserveFixedTraceDiagnosticOutput(join(directory, 'missing', 'artifact.json'))).toThrow('Cannot exclusively reserve');
  });

  it('claims then finalizes through one exclusive descriptor', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    const reservation = reserveFixedTraceDiagnosticOutput(path);
    reservation.finalize('{"diagnosticOnly":true}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"diagnosticOnly":true}\n');
  });

  it('runs the manual diagnostic candidate path into a complete reserved artifact with scripted providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    const plan: FixedTraceDiagnosticProviderPlan = {
      name: 'anthropic',
      router: budgetedStage(router.provider, budget),
      generation: budgetedStage(router.provider, budget),
    };

    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [plan],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64),
        gitCommit: 'abcdef0',
        gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1',
        traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local',
        architectureArm: 'two_stage_llm_router',
      },
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    });

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as typeof artifact;
    expect(router.calls).toHaveLength(1);
    expect(persisted).toMatchObject({
      complete: true,
      diagnosticOnly: true,
      comparisonEligible: false,
      promotionEvidenceEligible: false,
      rolloutPass: false,
      runs: [{
        provider: 'anthropic',
        summary: { complete: true, comparisonEligible: false },
        observations: [{ traceId: selectedTrace.id, terminalStatus: 'ignored' }],
      }],
    });
    expect(persisted.runs[0].observations).toHaveLength(1);
    router.response.usage.inputTokens = 999_999;
    expect(artifact.runs[0].observations[0].metadata.router).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.000035,
    });
    expect(artifact.runs[0].summary.totalEstimatedCostUsd).toBe(0.000035);
    expect(persisted.runs[0].observations[0].metadata.router.usage).toMatchObject({ inputTokens: 10 });
  });

  it('freezes the complete two-plan artifact contract before a provider can mutate later plans', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const sourceBundleFiles = ['before.ts'];
    const budget = new FixedTraceBudget(1);
    const baseConfig = {
      sourceBundleSha256: 'a'.repeat(64),
      gitCommit: 'abcdef0',
      gitDirty: false,
      promptConfigVersion: 'before-prompt',
      traceSuite: [selectedTrace],
      traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
      toolDefinitions: [],
      toolDefinitionProvenance: 'fixture_local' as const,
      architectureArm: 'two_stage_llm_router' as const,
    };
    let secondPlan!: FixedTraceDiagnosticProviderPlan;
    const first = scriptedRouter(() => {
      baseConfig.sourceBundleSha256 = 'b'.repeat(64);
      baseConfig.promptConfigVersion = 'forged-after-first-plan';
      sourceBundleFiles.push('forged-after-first-plan.ts');
      secondPlan.router.maxOutputTokens = 1;
      secondPlan.router.pricing.source = 'forged-after-first-plan';
    });
    const second = scriptedRouter(() => {
      first.response.usage.inputTokens = 999_999;
    }, 'openai');
    secondPlan = {
      name: 'openai',
      router: budgetedStage(second.provider, budget),
      generation: budgetedStage(second.provider, budget),
    };

    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [
        {
          name: 'anthropic',
          router: budgetedStage(first.provider, budget),
          generation: budgetedStage(first.provider, budget),
        },
        secondPlan,
      ],
      baseConfig,
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles,
      budgetNote: 'Synthetic no-network budget note.',
    });

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as typeof artifact;
    expect(persisted).toMatchObject({
      sourceBundleSha256: 'a'.repeat(64),
      promptConfigVersion: 'before-prompt',
      sourceBundleFiles: ['before.ts'],
      requestedProviders: ['anthropic', 'openai'],
    });
    expect(persisted.runs[1].requestedConfig.router).toMatchObject({
      provider: 'openai',
      maxOutputTokens: 300,
      pricing: { source: 'Synthetic manual artifact pricing.' },
    });
    expect(persisted.runs[0].observations[0].metadata.router).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.000035,
    });
    for (const run of persisted.runs) {
      expect(run.observations[0].metadata).toMatchObject({
        sourceBundleSha256: persisted.sourceBundleSha256,
        promptConfigVersion: persisted.promptConfigVersion,
        traceSuiteSha256: persisted.traceSuiteSha256,
        addieCodeVersion: persisted.addieCodeVersion,
        repetition: persisted.repetition,
      });
    }
  });

  it('rejects a provider-mismatched plan before scripted dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    const baseConfig = {
      sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
      promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
      traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
      toolDefinitionProvenance: 'fixture_local' as const,
      architectureArm: 'two_stage_llm_router' as const,
    };
    const invoke = (plans: FixedTraceDiagnosticProviderPlan[]) => runFixedTraceDiagnosticArtifact({
      plans,
      baseConfig,
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    });
    const plan = {
      name: 'anthropic',
      router: budgetedStage(router.provider, budget),
      generation: budgetedStage(router.provider, budget),
    };
    await expect(invoke([{ ...plan, name: 'not-anthropic' }])).rejects.toThrow('provider plans require unique names');
    const duplicatePath = join(directory, 'duplicate-artifact.json');
    await expect(runFixedTraceDiagnosticArtifact({
      plans: [plan, { ...plan }],
      baseConfig,
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(duplicatePath),
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    })).rejects.toThrow('provider plans require unique names');
    expect(router.calls).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readFileSync(duplicatePath, 'utf8')).toBe('');
  });

  it('does not let a final-response mutation alter its snapshotted manual artifact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    let plan!: FixedTraceDiagnosticProviderPlan;
    const router = scriptedRouter(() => { plan.router.model = 'mutated-after-final-response'; });
    const budget = new FixedTraceBudget(1);
    plan = {
      name: 'anthropic',
      router: budgetedStage(router.provider, budget),
      generation: budgetedStage(router.provider, budget),
    };

    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [plan],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64),
        gitCommit: 'abcdef0',
        gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1',
        traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local',
        architectureArm: 'two_stage_llm_router',
      },
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    });

    expect(router.calls).toHaveLength(1);
    expect(artifact.runs[0].requestedConfig.router.model).toBe('synthetic-manual-model');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ complete: true, diagnosticOnly: true });
  });
});

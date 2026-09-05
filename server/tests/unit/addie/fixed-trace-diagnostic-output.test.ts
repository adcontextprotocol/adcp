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
import { canonicalFixedTraceToolDefinitions } from '../../../src/addie/eval/fixed-trace-tools.js';
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

const ZERO_RATE_PRICING: FixedTracePricing = {
  ...PRICING,
  profileId: 'synthetic-zero-rate-artifact-v1',
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  source: 'Synthetic zero-rate artifact pricing.',
};

const DIAGNOSTIC_TEST_REQUEST: ModelRequest = {
  model: 'synthetic-manual-model',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request.' }] }],
  tools: [],
  maxOutputTokens: 1,
};

function scriptedRouter(
  afterFinalResponse?: (response: ModelResponse) => void,
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
      afterFinalResponse?.(response);
    },
  };
  return { provider, calls, response };
}

function stage(
  provider: ModelProvider,
  pricing: FixedTracePricing = PRICING,
): FixedTraceProviderStageConfig {
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
    pricing: structuredClone(pricing),
  };
}

function budgetedStage(
  provider: ModelProvider,
  budget: FixedTraceBudget,
  responsePricingApproved: (response: ModelResponse) => boolean = () => true,
  pricing: FixedTracePricing = PRICING,
): FixedTraceProviderStageConfig {
  return stage(new BudgetedFixedTraceProvider(provider, budget, pricing, responsePricingApproved), pricing);
}

function twoTurnProvider(
  afterRouterResponse?: () => void,
): { provider: ModelProvider; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  let generationTurn = 0;
  const provider: ModelProvider = {
    id: 'anthropic',
    capabilities: CAPABILITIES,
    prepare(request): PreparedModelInvocation {
      return {
        provider: 'anthropic', model: request.model, capabilities: CAPABILITIES,
        requestMetadata: request.requestMetadata,
        providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
      };
    },
    async *respond(request, options = {}): AsyncIterable<NormalizedModelEvent> {
      await options.beforeDispatch?.(this.prepare(request));
      calls.push(structuredClone(request));
      const router = request.requestMetadata?.purpose === 'fixed_trace_router';
      const response: ModelResponse = router
        ? {
            provider: 'anthropic', model: 'synthetic-manual-model', id: 'router',
            content: [{ type: 'text', text: JSON.stringify({
              action: 'respond', tool_sets: ['knowledge'], confidence: 'high',
              requires_depth: false, reason: 'Synthetic route.',
            }) }],
            finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
          }
        : generationTurn++ === 0
          ? {
              provider: 'anthropic', model: 'synthetic-manual-model', id: 'generation-tool',
              content: [{ type: 'tool_call', id: 'tool-1', name: 'search_docs', input: { query: 'task model' } }],
              finishReason: 'tool_calls', providerFinishReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 },
            }
          : {
              provider: 'anthropic', model: 'synthetic-manual-model', id: 'generation-final',
              content: [{ type: 'text', text: 'A buyer calls a seller task and receives its structured response.' }],
              finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
            };
      yield { type: 'response_start', provider: 'anthropic', model: response.model, id: response.id };
      for (const [index, content] of response.content.entries()) {
        if (content.type === 'text') yield { type: 'text_delta', index, text: content.text };
        if (content.type === 'tool_call') yield { type: 'tool_call', index, call: content };
      }
      yield { type: 'response_complete', response };
      if (router) afterRouterResponse?.();
    },
  };
  return { provider, calls };
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
    expect(artifact.runs[0].runId).toBe('synthetic-manual-root:anthropic');
    expect(artifact.runs[0].observations.every((observation) => (
      observation.metadata.runId === artifact.runs[0].runId
    ))).toBe(true);
    expect(artifact.budget).toMatchObject({
      accountedSpendUsd: 0.000035,
      dispatchedCalls: 1,
      completedCalls: 1,
      budgetRejectedCalls: 0,
      exposureUnknown: false,
    });
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
    expect(artifact.runs.map((run) => run.runId)).toEqual([
      'synthetic-manual-root:anthropic',
      'synthetic-manual-root:openai',
    ]);
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

  it('derives child run IDs internally instead of accepting an unrelated callback result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: budgetedStage(router.provider, budget), generation: budgetedStage(router.provider, budget) }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      // This former input is intentionally ignored at runtime as well as
      // removed from the public type, so a JavaScript caller cannot forge it.
      runIdForProvider: () => 'unrelated-id',
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    } as unknown as Parameters<typeof runFixedTraceDiagnosticArtifact>[0]);

    expect(artifact.runs[0].runId).toBe('root:anthropic');
    expect(artifact.runs[0].observations[0].metadata.runId).toBe('root:anthropic');
  });

  it('rejects a subclass that claims budget binding while bypassing the ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const delegate = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    class BypassingBudgetProvider extends BudgetedFixedTraceProvider {
      constructor() {
        super(delegate.provider, budget, PRICING, () => true);
      }

      // This was previously trusted through instanceof plus a public,
      // overridable isBoundToBudget predicate.
      isBoundToBudget(): boolean { return true; }

      override async *respond(
        request: ModelRequest,
        options: ModelRespondOptions = {},
      ): AsyncIterable<NormalizedModelEvent> {
        yield* delegate.provider.respond(request, options);
      }
    }
    const bypass = new BypassingBudgetProvider();

    await expect(runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: stage(bypass), generation: stage(bypass) }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    })).rejects.toThrow('provider plans require unique names');
    expect(delegate.calls).toHaveLength(0);
    expect(budget.snapshot()).toMatchObject({ accountedSpendUsd: 0, dispatchedCalls: 0, completedCalls: 0 });
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('keeps collector, metadata, summary, ledger, and artifact on the terminal snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter((response) => {
      response.id = 'forged-id';
      response.model = 'forged-model';
      response.content[0] = { type: 'text', text: 'forged response' };
      response.usage.inputTokens = 999_999;
      response.usage.outputTokens = 999_999;
    });
    const budget = new FixedTraceBudget(1);
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: budgetedStage(router.provider, budget), generation: budgetedStage(router.provider, budget) }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as typeof artifact;
    const observation = artifact.runs[0].observations[0];

    expect(observation.metadata.router).toMatchObject({
      returnedModel: 'synthetic-manual-model',
      usage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.000035,
    });
    expect(artifact.runs[0].summary.totalEstimatedCostUsd).toBe(0.000035);
    expect(artifact.budget).toMatchObject({ accountedSpendUsd: 0.000035, dispatchedCalls: 1, completedCalls: 1 });
    expect(persisted.runs[0].observations[0].metadata.router.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(persisted.budget.accountedSpendUsd).toBe(0.000035);
  });

  it('retains an unknown-model response as unknown exposure without inventing a spend equality', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    router.response.model = 'unapproved-model';
    const budget = new FixedTraceBudget(1);
    const approval = (response: ModelResponse) => response.model === 'synthetic-manual-model';
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{
        name: 'anthropic',
        router: budgetedStage(router.provider, budget, approval),
        generation: budgetedStage(router.provider, budget, approval),
      }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    expect(artifact.runs[0].observations[0].metadata.router).toMatchObject({
      source: 'provider', returnedModel: 'unapproved-model', estimatedCostUsd: null,
    });
    expect(artifact.runs[0].summary.totalEstimatedCostUsd).toBeNull();
    expect(artifact.budget).toMatchObject({
      accountedSpendUsd: 0, dispatchedCalls: 1, completedCalls: 0, exposureUnknown: true,
    });
  });

  it('reconciles a pre-dispatch budget rejection with a local/not-run observation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(0.000001);
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: budgetedStage(router.provider, budget), generation: budgetedStage(router.provider, budget) }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    expect(artifact.runs[0].observations[0]).toMatchObject({
      terminalStatus: 'not_dispatched_budget',
      metadata: { router: { source: 'local', dispatched: false }, generation: { source: 'not_run' } },
    });
    expect(artifact.budget).toMatchObject({
      accountedSpendUsd: 0, dispatchedCalls: 0, completedCalls: 0, budgetRejectedCalls: 1, exposureUnknown: false,
    });
  });

  it('preflights every plan before leasing a pristine budget or dispatching an earlier plan', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const failedPath = join(directory, 'failed-artifact.json');
    const completedPath = join(directory, 'completed-artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const first = scriptedRouter(undefined, 'anthropic');
    const second = scriptedRouter(undefined, 'openai');
    const budget = new FixedTraceBudget(1);
    const firstPlan: FixedTraceDiagnosticProviderPlan = {
      name: 'anthropic',
      router: budgetedStage(first.provider, budget),
      generation: budgetedStage(first.provider, budget),
    };
    const invalidSecondPlan: FixedTraceDiagnosticProviderPlan = {
      name: 'openai',
      router: budgetedStage(second.provider, budget),
      generation: budgetedStage(second.provider, budget),
    };
    invalidSecondPlan.generation.maxIterations = 0;
    const invoke = (
      plans: readonly FixedTraceDiagnosticProviderPlan[],
      path: string,
    ) => runFixedTraceDiagnosticArtifact({
      plans,
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    await expect(invoke([firstPlan, invalidSecondPlan], failedPath)).rejects.toThrow(
      'generation maxIterations must be between',
    );
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
    expect(readFileSync(failedPath, 'utf8')).toBe('');
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      reservedUsd: 0,
      dispatchedCalls: 0,
      completedCalls: 0,
      budgetRejectedCalls: 0,
      admissionClosed: false,
      exposureUnknown: false,
    });

    const validSecondPlan: FixedTraceDiagnosticProviderPlan = {
      name: 'openai',
      router: budgetedStage(second.provider, budget),
      generation: budgetedStage(second.provider, budget),
    };
    const artifact = await invoke([firstPlan, validSecondPlan], completedPath);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(artifact.budget).toMatchObject({
      accountedSpendUsd: 0.00007,
      dispatchedCalls: 2,
      completedCalls: 2,
      budgetRejectedCalls: 0,
      exposureUnknown: false,
    });
  });

  it('prevents post-preflight method and prototype tampering in a two-turn zero-rate run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'knowledge-task-model');
    if (!selectedTrace) throw new Error('Missing synthetic knowledge trace');
    const attacks: string[] = [];
    let generation!: BudgetedFixedTraceProvider;
    const delegate = twoTurnProvider(() => {
      const replace = (name: string, attempt: () => void) => {
        try { attempt(); } catch { attacks.push(name); }
      };
      replace('own_respond', () => Object.defineProperty(generation, 'respond', { value: delegate.provider.respond }));
      replace('own_prepare', () => Object.defineProperty(generation, 'prepare', { value: delegate.provider.prepare }));
      replace('prototype_swap', () => Object.setPrototypeOf(generation, {}));
      replace('prototype_respond', () => Object.defineProperty(BudgetedFixedTraceProvider.prototype, 'respond', { value: delegate.provider.respond }));
      replace('prototype_prepare', () => Object.defineProperty(BudgetedFixedTraceProvider.prototype, 'prepare', { value: delegate.provider.prepare }));
    });
    const budget = new FixedTraceBudget(1);
    const router = new BudgetedFixedTraceProvider(delegate.provider, budget, ZERO_RATE_PRICING, () => true);
    generation = new BudgetedFixedTraceProvider(delegate.provider, budget, ZERO_RATE_PRICING, () => true);
    const generationStage = stage(generation, ZERO_RATE_PRICING);
    generationStage.maxIterations = 2;
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: stage(router, ZERO_RATE_PRICING), generation: generationStage }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: canonicalFixedTraceToolDefinitions().filter((tool) => ['search_docs', 'get_doc'].includes(tool.name)),
        toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    expect(attacks).toEqual(['own_respond', 'own_prepare', 'prototype_swap', 'prototype_respond', 'prototype_prepare']);
    expect(delegate.calls).toHaveLength(3);
    expect(artifact.runs[0].observations[0].metadata).toMatchObject({
      router: { dispatchedCalls: 1, estimatedCostUsd: 0 },
      generation: { dispatchedCalls: 2, estimatedCostUsd: 0 },
    });
    expect(artifact.runs[0].summary.totalEstimatedCostUsd).toBe(0);
    expect(artifact.budget).toMatchObject({
      accountedSpendUsd: 0, dispatchedCalls: 3, completedCalls: 3, budgetRejectedCalls: 0, exposureUnknown: false,
    });
  });

  it('rejects a zero-rate ledger with preexisting completed, unknown, or rejected activity', async () => {
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const invoke = async (budget: FixedTraceBudget, suffix: string) => {
      const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
      const provider = scriptedRouter();
      await expect(runFixedTraceDiagnosticArtifact({
        plans: [{ name: 'anthropic', router: budgetedStage(provider.provider, budget, () => true, ZERO_RATE_PRICING), generation: budgetedStage(provider.provider, budget, () => true, ZERO_RATE_PRICING) }],
        baseConfig: {
          sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
          promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
          traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: [],
          toolDefinitionProvenance: 'fixture_local', architectureArm: 'two_stage_llm_router',
        },
        budget,
        outputReservation: reserveFixedTraceDiagnosticOutput(join(directory, `${suffix}.json`)),
        runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
        sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
      })).rejects.toThrow('budget must be pristine and exclusively claimed');
      expect(provider.calls).toHaveLength(0);
    };
    const prepared = scriptedRouter().provider.prepare(DIAGNOSTIC_TEST_REQUEST);
    const completed = new FixedTraceBudget(1);
    const completedReservation = completed.reserve(prepared, 1, ZERO_RATE_PRICING);
    completed.markDispatched(completedReservation);
    completed.complete(completedReservation, { inputTokens: 1, outputTokens: 1 }, ZERO_RATE_PRICING);
    await invoke(completed, 'completed');

    const unknown = new FixedTraceBudget(1);
    const unknownReservation = unknown.reserve(prepared, 1, ZERO_RATE_PRICING);
    unknown.markDispatched(unknownReservation);
    unknown.markExposureUnknown(unknownReservation);
    await invoke(unknown, 'unknown');

    const rejected = new FixedTraceBudget(0.000001);
    expect(() => rejected.reserve(prepared, 1, PRICING)).toThrow();
    await invoke(rejected, 'rejected');
  });
});

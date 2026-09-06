import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceResponsePricingPolicy,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import {
  assertFixedTraceDiagnosticBudgetReconciliation,
  runFixedTraceDiagnosticArtifact,
  type FixedTraceDiagnosticProviderPlan,
} from '../../../src/addie/eval/fixed-trace-diagnostic-run.js';
import { reserveFixedTraceDiagnosticOutput } from '../../../src/addie/eval/fixed-trace-diagnostic-output.js';
import { datedPricingProfilesForFixedTrace } from '../../../src/addie/eval/dated-pricing-cohort.js';
import {
  fixedTraceCommonToolDefinitions,
  fixedTraceHybridPolicy,
} from '../../../src/addie/eval/fixed-trace-architecture.js';
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

const DATED_PROFILES = datedPricingProfilesForFixedTrace();
function approvedFixturePricing(candidateId: 'anthropic-router' | 'openai-router-generator'): FixedTracePricing {
  const profile = DATED_PROFILES.find((entry) => entry.candidateId === candidateId);
  if (!profile) throw new Error(`Missing dated pricing fixture for ${candidateId}`);
  return {
    profileId: profile.profileId,
    inputUsdPerMillionTokens: profile.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: profile.outputUsdPerMillionTokens,
    cacheReadUsdPerMillionTokens: profile.cacheReadUsdPerMillionTokens,
    cacheWriteUsdPerMillionTokens: profile.cacheWriteUsdPerMillionTokens,
    cacheReadAccounting: profile.cacheReadAccounting,
    cacheWriteAccounting: profile.cacheWriteAccounting,
    source: profile.source,
  };
}

const PRICING = approvedFixturePricing('anthropic-router');

const MODEL = 'claude-haiku-4-5';
const OPENAI_MODEL = 'gpt-5.6-luna';
const OPENAI_PRICING = approvedFixturePricing('openai-router-generator');

const ZERO_RATE_PRICING: FixedTracePricing = {
  ...PRICING,
  profileId: 'synthetic-zero-rate-artifact-v1',
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  source: 'Synthetic zero-rate artifact pricing.',
};

const DIAGNOSTIC_TEST_REQUEST: ModelRequest = {
  model: MODEL,
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request.' }] }],
  tools: [],
  maxOutputTokens: 1,
};

// Diagnostic artifacts are architecture-comparison components. Every test
// therefore uses the same evaluator-owned candidate surface, never fixtures.
const COMMON_TOOL_DEFINITIONS = fixedTraceCommonToolDefinitions('two_stage_llm_router');

function scriptedRouter(
  afterFinalResponse?: (response: ModelResponse) => void,
  providerId: ModelProviderId = 'anthropic',
): { provider: ModelProvider; calls: ModelRequest[]; response: ModelResponse } {
  const calls: ModelRequest[] = [];
  const response: ModelResponse = {
    provider: providerId,
    model: providerId === 'openai' ? OPENAI_MODEL : MODEL,
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

function cloneChangingIdentityProvider(): {
  provider: ModelProvider;
  calls: ModelRequest[];
  idReads: () => number;
} {
  const calls: ModelRequest[] = [];
  let reads = 0;
  const provider: ModelProvider = {
    get id(): ModelProviderId {
      reads++;
      return reads === 1 ? 'anthropic' : 'openai';
    },
    capabilities: CAPABILITIES,
    prepare(request): PreparedModelInvocation {
      // The delegate's request surface is stable; only an old clone's second
      // read of `id` would change the wrapper identity.
      return {
        provider: 'anthropic', model: request.model, capabilities: CAPABILITIES,
        requestMetadata: request.requestMetadata,
        providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
      };
    },
    async *respond(request, options = {}): AsyncIterable<NormalizedModelEvent> {
      await options.beforeDispatch?.(this.prepare(request));
      calls.push(structuredClone(request));
      const response: ModelResponse = {
        provider: 'anthropic', model: MODEL, id: 'stable-response',
        content: [{ type: 'text', text: JSON.stringify({ action: 'ignore', reason: 'Synthetic route.' }) }],
        finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
      };
      yield { type: 'response_start', provider: 'anthropic', model: response.model, id: response.id };
      yield { type: 'text_delta', index: 0, text: response.content[0].type === 'text' ? response.content[0].text : '' };
      yield { type: 'response_complete', response };
    },
  };
  return { provider, calls, idReads: () => reads };
}

function stage(
  provider: ModelProvider,
  pricing: FixedTracePricing = provider.id === 'openai' ? OPENAI_PRICING : PRICING,
): FixedTraceProviderStageConfig {
  return {
    provider,
    model: provider.id === 'openai' ? OPENAI_MODEL : MODEL,
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
  pricing: FixedTracePricing = provider.id === 'openai' ? OPENAI_PRICING : PRICING,
): FixedTraceProviderStageConfig {
  const configured = stage(provider, pricing);
  return {
    ...configured,
    provider: new BudgetedFixedTraceProvider(
      provider,
      budget,
      configured.pricing,
      fixedTraceResponsePricingPolicy(provider.id, configured.model, configured.pricing),
    ),
  };
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
            provider: 'anthropic', model: MODEL, id: 'router',
            content: [{ type: 'text', text: JSON.stringify({
              action: 'respond', tool_sets: ['knowledge'], confidence: 'high',
              requires_depth: false, reason: 'Synthetic route.',
            }) }],
            finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
          }
        : generationTurn++ === 0
          ? {
              provider: 'anthropic', model: MODEL, id: 'generation-tool',
              content: [{ type: 'tool_call', id: 'tool-1', name: 'search_docs', input: { query: 'task model' } }],
              finishReason: 'tool_calls', providerFinishReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 },
            }
          : {
              provider: 'anthropic', model: MODEL, id: 'generation-final',
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
        toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
        architectureArm: 'deterministic_policy_llm_fallback_hybrid',
        hybridPolicy: fixedTraceHybridPolicy(),
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
      architectureArm: { id: 'deterministic_policy_llm_fallback_hybrid', diagnosticOnly: true },
      hybridPolicy: fixedTraceHybridPolicy(),
      runs: [{
        provider: 'anthropic',
        summary: {
          complete: true,
          comparisonEligible: false,
          expectedEndpointDenominators: {
            deterministic: 1,
            answer: null,
            routing: null,
            toolSelection: 1,
            mutationSafety: null,
            metadata: 1,
          },
        },
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
      toolDefinitions: COMMON_TOOL_DEFINITIONS,
      toolDefinitionProvenance: 'evaluator_owned_common_tool_universe' as const,
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
      pricing: { source: 'OpenAI gpt-5.6-luna standard, checked 2026-09-05.' },
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
      traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
      toolDefinitionProvenance: 'evaluator_owned_common_tool_universe' as const,
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

  it('rejects a plan identity accessor before it can change validation into execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const failedPath = join(directory, 'failed-artifact.json');
    const completedPath = join(directory, 'completed-artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    let nameReads = 0;
    const accessorPlan = {
      // The old validation read this as "anthropic" six times, then copied
      // "forged" into its execution snapshot. Accessors are now rejected
      // before either a lease or a provider dispatch is possible.
      get name() {
        nameReads++;
        return nameReads <= 6 ? 'anthropic' : 'forged';
      },
      router: budgetedStage(router.provider, budget),
      generation: budgetedStage(router.provider, budget),
    };
    const invoke = (plans: readonly FixedTraceDiagnosticProviderPlan[], path: string) => runFixedTraceDiagnosticArtifact({
      plans,
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    await expect(invoke([accessorPlan] as unknown as FixedTraceDiagnosticProviderPlan[], failedPath))
      .rejects.toThrow('provider plan 0.name must be an own data property');
    expect(nameReads).toBe(0);
    expect(router.calls).toHaveLength(0);
    expect(readFileSync(failedPath, 'utf8')).toBe('');
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0, reservedUsd: 0, dispatchedCalls: 0,
      completedCalls: 0, budgetRejectedCalls: 0, admissionClosed: false, exposureUnknown: false,
    });

    const artifact = await invoke([{
      name: 'anthropic', router: accessorPlan.router, generation: accessorPlan.generation,
    }], completedPath);
    expect(router.calls).toHaveLength(1);
    expect(artifact.runs[0]).toMatchObject({ provider: 'anthropic', runId: 'root:anthropic' });
  });

  it('never rereads a delegate identity while cloning an authenticated plan', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const changing = cloneChangingIdentityProvider();
    const budget = new FixedTraceBudget(1);
    const wrapper = new BudgetedFixedTraceProvider(
      changing.provider,
      budget,
      PRICING,
      fixedTraceResponsePricingPolicy('anthropic', MODEL, PRICING),
    );
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{ name: 'anthropic', router: stage(wrapper), generation: stage(wrapper) }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    expect(changing.idReads()).toBe(1);
    expect(changing.calls).toHaveLength(1);
    expect(artifact).toMatchObject({ requestedProviders: ['anthropic'] });
    expect(artifact.runs[0]).toMatchObject({ provider: 'anthropic', runId: 'root:anthropic' });
    expect(artifact.runs[0].observations[0].metadata.router).toMatchObject({
      requestedProvider: 'anthropic', returnedProvider: 'anthropic', estimatedCostUsd: 0.000035,
    });
  });

  it('rejects a self-declared zero-rate profile before lease or dispatch and leaves the budget reusable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const failedPath = join(directory, 'forged-artifact.json');
    const retryPath = join(directory, 'retry-artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1e-12);
    const trustedRouter = budgetedStage(router.provider, budget);
    const trustedGeneration = budgetedStage(router.provider, budget);
    const forgedPricing: FixedTracePricing = {
      ...ZERO_RATE_PRICING,
      profileId: 'attacker-says-reviewed-v1',
      source: 'attacker assertion',
    };
    const invoke = (plans: readonly FixedTraceDiagnosticProviderPlan[], path: string) => runFixedTraceDiagnosticArtifact({
      plans,
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    await expect(invoke([{
      name: 'anthropic', router: { ...trustedRouter, pricing: forgedPricing }, generation: trustedGeneration,
    }], failedPath)).rejects.toThrow('Fixed trace pricing profile is not evaluator approved');
    expect(router.calls).toHaveLength(0);
    expect(readFileSync(failedPath, 'utf8')).toBe('');
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0, reservedUsd: 0, dispatchedCalls: 0,
      completedCalls: 0, budgetRejectedCalls: 0, admissionClosed: false, exposureUnknown: false,
    });

    const artifact = await invoke([{
      name: 'anthropic', router: trustedRouter, generation: trustedGeneration,
    }], retryPath);
    expect(artifact.budget).toMatchObject({ dispatchedCalls: 0, completedCalls: 0, budgetRejectedCalls: 1 });
    expect(readFileSync(retryPath, 'utf8')).not.toBe('');
  });

  it('rejects nested pricing accessors without reading them and leaves the budget reusable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const failedPath = join(directory, 'accessor-artifact.json');
    const retryPath = join(directory, 'retry-artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const budget = new FixedTraceBudget(1);
    const trustedRouter = budgetedStage(router.provider, budget);
    const trustedGeneration = budgetedStage(router.provider, budget);
    const accessorPricing = { ...PRICING } as FixedTracePricing;
    let pricingReads = 0;
    Object.defineProperty(accessorPricing, 'inputUsdPerMillionTokens', {
      enumerable: true,
      get() { pricingReads++; return 0; },
    });
    const invoke = (plans: readonly FixedTraceDiagnosticProviderPlan[], path: string) => runFixedTraceDiagnosticArtifact({
      plans,
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    await expect(invoke([{
      name: 'anthropic', router: { ...trustedRouter, pricing: accessorPricing }, generation: trustedGeneration,
    }], failedPath)).rejects.toThrow('provider plan 0.router.pricing.inputUsdPerMillionTokens must be an own data property');
    expect(pricingReads).toBe(0);
    expect(router.calls).toHaveLength(0);
    expect(readFileSync(failedPath, 'utf8')).toBe('');
    expect(budget.snapshot()).toMatchObject({ dispatchedCalls: 0, completedCalls: 0, budgetRejectedCalls: 0 });

    await invoke([{ name: 'anthropic', router: trustedRouter, generation: trustedGeneration }], retryPath);
    expect(router.calls).toHaveLength(1);
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
        toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
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
    expect(artifact.runs[0].requestedConfig.router.model).toBe(MODEL);
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
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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
        super(
          delegate.provider,
          budget,
          PRICING,
          fixedTraceResponsePricingPolicy('anthropic', MODEL, PRICING),
        );
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
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as typeof artifact;
    const observation = artifact.runs[0].observations[0];

    expect(observation.metadata.router).toMatchObject({
      returnedModel: MODEL,
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
    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [{
        name: 'anthropic',
        router: budgetedStage(router.provider, budget),
        generation: budgetedStage(router.provider, budget),
      }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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

  it('rejects a settled ledger for an unpriced dispatched provider response', () => {
    const providerStage = {
      source: 'provider', dispatched: true, dispatchedCalls: 1,
      usageKnown: true, usage: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: null,
    };
    const notRunStage = {
      source: 'not_run', dispatched: false, dispatchedCalls: 0,
      usageKnown: false, usage: null, estimatedCostUsd: 0,
    };
    expect(() => assertFixedTraceDiagnosticBudgetReconciliation({
      policy: 'soft_admission_target', softMaxUsd: 1, accountedSpendUsd: 0.000035,
      reservedUsd: 0, remainingUsd: 0.999965, dispatchedCalls: 1, completedCalls: 1,
      budgetRejectedCalls: 0, admissionClosed: false, exposureUnknown: false,
    }, [{ observations: [{
      terminalStatus: 'complete',
      metadata: { router: providerStage, generation: notRunStage },
    }] }] as never)).toThrow('unpriced dispatched response lacks unknown budget exposure');
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
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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
      dispatchedCalls: 2,
      completedCalls: 2,
      budgetRejectedCalls: 0,
      exposureUnknown: false,
    });
    expect(artifact.budget.accountedSpendUsd).toBeCloseTo(0.000043);
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
    const policy = fixedTraceResponsePricingPolicy('anthropic', MODEL, PRICING);
    const router = new BudgetedFixedTraceProvider(delegate.provider, budget, PRICING, policy);
    generation = new BudgetedFixedTraceProvider(delegate.provider, budget, PRICING, policy);
    const generationStage = stage(generation, PRICING);
    generationStage.maxIterations = 2;
    const artifact = await runFixedTraceDiagnosticArtifact({
        plans: [{ name: 'anthropic', router: stage(router, PRICING), generation: generationStage }],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: COMMON_TOOL_DEFINITIONS,
        toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
      },
      budget,
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      runRootId: 'root', runStartedAt: '2026-09-05T00:00:00.000Z',
      sourceBundleFiles: ['synthetic.ts'], budgetNote: 'Synthetic no-network budget note.',
    });

    expect(attacks).toEqual(['own_respond', 'own_prepare', 'prototype_swap', 'prototype_respond', 'prototype_prepare']);
    expect(delegate.calls).toHaveLength(3);
    expect(artifact.runs[0].observations[0].metadata).toMatchObject({
      router: { dispatchedCalls: 1, estimatedCostUsd: 0.000035 },
      generation: { dispatchedCalls: 2, estimatedCostUsd: 0.00007 },
    });
    expect(artifact.runs[0].summary.totalEstimatedCostUsd).toBeCloseTo(0.000105);
    expect(artifact.budget).toMatchObject({
      dispatchedCalls: 3, completedCalls: 3, budgetRejectedCalls: 0, exposureUnknown: false,
    });
    expect(artifact.budget.accountedSpendUsd).toBeCloseTo(0.000105);
  });

  it('rejects a zero-rate ledger with preexisting completed, unknown, or rejected activity', async () => {
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const invoke = async (budget: FixedTraceBudget, suffix: string) => {
      const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
      const provider = scriptedRouter();
      await expect(runFixedTraceDiagnosticArtifact({
        plans: [{ name: 'anthropic', router: budgetedStage(provider.provider, budget), generation: budgetedStage(provider.provider, budget) }],
        baseConfig: {
          sourceBundleSha256: 'a'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
          promptConfigVersion: 'synthetic-manual-prompt-v1', traceSuite: [selectedTrace],
          traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]), toolDefinitions: COMMON_TOOL_DEFINITIONS,
          toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm: 'two_stage_llm_router',
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

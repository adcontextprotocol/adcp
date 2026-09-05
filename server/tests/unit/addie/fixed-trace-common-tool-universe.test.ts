import { describe, expect, it, vi } from 'vitest';
import {
  admitFixedTraceCommonToolUniverse,
  assertFixedTraceCommonToolUniverseAdmission,
  FixedTraceCommonToolUniverseAdmissionError,
  fixedTraceCommonToolDefinitions,
  fixedTraceCommonToolUniverseProvenance,
} from '../../../src/addie/eval/fixed-trace-architecture.js';
import {
  createSyntheticDirectToolReceiptHandlers,
  FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
} from '../../../src/addie/direct-tool-universe.js';
import { runFixedTraceDiagnosticCandidate } from '../../../src/addie/eval/fixed-trace-diagnostic-run.js';
import { FIXED_TRACE_SUITE, fixedTraceSuiteSha256, type FixedTraceCase } from '../../../src/addie/eval/fixed-trace-suite.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';
import type { FixedTraceRunnerConfig } from '../../../src/addie/eval/fixed-trace-runner.js';

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: ['provider_default', 'none', 'low', 'medium', 'high'],
  customTools: true,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

class NeverDispatchProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = CAPABILITIES;
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({
    provider: this.id,
    model: request.model,
    capabilities: this.capabilities,
    requestMetadata: request.requestMetadata,
    providerRequest: request as unknown as Readonly<Record<string, unknown>>,
  }));
  readonly respond = vi.fn(async function* (
    _request: ModelRequest,
    _options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    throw new Error('must not dispatch');
  });
}

class ScriptedProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = CAPABILITIES;
  readonly requests: ModelRequest[] = [];
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({
    provider: this.id,
    model: request.model,
    capabilities: this.capabilities,
    requestMetadata: request.requestMetadata,
    providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
  }));

  constructor(private readonly responses: ModelResponse[]) {}

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error('Script exhausted');
    yield { type: 'response_start', provider: this.id, model: response.model, id: response.id };
    for (const [index, content] of response.content.entries()) {
      if (content.type === 'text') yield { type: 'text_delta', index, text: content.text };
      else if (content.type === 'tool_call') yield { type: 'tool_call', index, call: content };
    }
    yield { type: 'response_complete', response };
  }
}

function scriptedResponse(id: string, text: string): ModelResponse {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    id,
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function stage(provider: ModelProvider) {
  return {
    provider,
    model: 'claude-haiku-4-5',
    reasoningEffort: 'none' as const,
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations: 1,
    transportRetries: 0 as const,
    samplingMode: 'provider_no_sampling_control' as const,
    temperature: null,
    pricing: {
      profileId: 'anthropic-standard-2026-08:claude-haiku-4-5',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      cacheReadUsdPerMillionTokens: 0.1,
      cacheWriteUsdPerMillionTokens: 1.25,
      cacheReadAccounting: 'additive' as const,
      cacheWriteAccounting: 'additive' as const,
      source: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
    },
  };
}

function config(
  routerProvider: ModelProvider,
  generationProvider: ModelProvider,
  traceSuite: readonly FixedTraceCase[],
): FixedTraceRunnerConfig {
  return {
    runId: 'common-tool-universe-test',
    sourceBundleSha256: 'a'.repeat(64),
    gitCommit: 'abcdef0',
    gitDirty: false,
    promptConfigVersion: 'test',
    traceSuite,
    traceSuiteSha256: fixedTraceSuiteSha256(traceSuite),
    // Deliberately retain the legacy fixture list: the diagnostic admission
    // must reject it before either provider or handler boundary.
    toolDefinitions: [],
    toolDefinitionProvenance: 'fixture_local',
    architectureArm: 'two_stage_llm_router',
    router: stage(routerProvider),
    generation: stage(generationProvider),
  };
}

describe('fixed-trace common evaluator tool universe', () => {
  it('is identical for routed, direct, and hybrid arms', () => {
    const arms = [
      'two_stage_llm_router',
      'direct_generation',
      'deterministic_policy_llm_fallback_hybrid',
    ] as const;
    const definitions = arms.map((arm) => fixedTraceCommonToolDefinitions(arm));
    const provenance = arms.map((arm) => fixedTraceCommonToolUniverseProvenance(arm));

    expect(definitions.map((tools) => tools.map((tool) => tool.name))).toEqual([
      definitions[0]!.map((tool) => tool.name),
      definitions[0]!.map((tool) => tool.name),
      definitions[0]!.map((tool) => tool.name),
    ]);
    expect(provenance[1]).toEqual(provenance[0]);
    expect(provenance[2]).toEqual(provenance[0]);
  });

  it('does not let scoring-label or fixture mutation alter candidate-visible definitions', async () => {
    const original = FIXED_TRACE_SUITE.find((trace) => trace.id === 'knowledge-task-model')!;
    const labelMutated: FixedTraceCase = {
      ...original,
      routing: { action: 'respond', toolSets: ['admin_events'] },
      toolFixtures: [],
      expectation: { ...original.expectation, requiredTools: ['fixture_oracle_only'], allowedTools: ['fixture_oracle_only'] },
      answerRubric: ['Fixture oracle only.'],
    };
    // Change only labels used for scoring; request facts remain fixed.
    expect(labelMutated.request).toEqual(original.request);
    const originalRouter = new ScriptedProvider([
      // Keep the established fixed-trace `respond` plan shape intact.
      scriptedResponse('router-response', JSON.stringify({
        action: 'respond',
        tool_sets: [],
        confidence: 'high',
        requires_depth: false,
        reason: 'Synthetic route.',
      })),
    ]);
    const originalGeneration = new ScriptedProvider([
      scriptedResponse('generation-response', 'Synthetic terminal response.'),
    ]);
    const mutatedRouter = new ScriptedProvider([
      scriptedResponse('router-response', JSON.stringify({
        action: 'respond',
        tool_sets: [],
        confidence: 'high',
        requires_depth: false,
        reason: 'Synthetic route.',
      })),
    ]);
    const mutatedGeneration = new ScriptedProvider([
      scriptedResponse('generation-response', 'Synthetic terminal response.'),
    ]);

    const originalResult = await runFixedTraceDiagnosticCandidate({
      ...config(originalRouter, originalGeneration, [original]),
      toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
    });
    const mutatedResult = await runFixedTraceDiagnosticCandidate({
      ...config(mutatedRouter, mutatedGeneration, [labelMutated]),
      toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
    });

    expect(originalResult.observations[0]!.metadata.executionEnvelope.source)
      .toBe('evaluator_owned_synthetic_receipt_envelope');
    expect(mutatedResult.observations[0]!.terminalStage).toBe('generation');
    expect(originalGeneration.requests).toHaveLength(1);
    expect(mutatedGeneration.requests).toHaveLength(1);
    expect(mutatedGeneration.requests[0]!.tools.map((tool) => tool.name)).toEqual(
      originalGeneration.requests[0]!.tools.map((tool) => tool.name),
    );
    expect(mutatedGeneration.requests[0]!.tools.map((tool) => tool.name))
      .toEqual(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames);
  });

  it('does not consume a caller-mutated synthetic handler map or misstate its binding evidence', async () => {
    const externalHandlerMap = new Map(createSyntheticDirectToolReceiptHandlers(
      FIXED_TRACE_DIRECT_TOOL_UNIVERSE,
    ).map((handler) => [handler.definition.name, handler.handler]));
    const replacement = vi.fn(async () => '{"attacker":"handler"}');
    externalHandlerMap.set('search_docs', replacement);
    const router = new ScriptedProvider([
      scriptedResponse('router-response', JSON.stringify({
        action: 'respond', tool_sets: [], confidence: 'high', requires_depth: false, reason: 'Synthetic route.',
      })),
    ]);
    const generation = new ScriptedProvider([
      {
        provider: 'anthropic', model: 'claude-haiku-4-5', id: 'tool-call-response',
        content: [{ type: 'tool_call', id: 'search-docs-probe', name: 'search_docs', input: { query: 'probe' } }],
        finishReason: 'tool_calls', providerFinishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 },
      },
      scriptedResponse('generation-response', 'Synthetic terminal response.'),
    ]);
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-task-model')!;
    const runConfig = {
      ...config(router, generation, [trace]),
      toolDefinitionProvenance: 'evaluator_owned_common_tool_universe' as const,
    };
    runConfig.generation.maxIterations = 2;

    const result = await runFixedTraceDiagnosticCandidate(runConfig);

    expect(replacement).not.toHaveBeenCalled();
    expect(generation.requests).toHaveLength(2);
    const searchDocs = FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.find(
      (tool) => tool.definition.name === 'search_docs',
    )!;
    expect(JSON.stringify(generation.requests[1])).toContain('synthetic_direct_tool_receipt');
    expect(JSON.stringify(generation.requests[1])).toContain(searchDocs.handlerIdentitySha256);
    expect(result.observations[0]!.metadata.toolUniverse).toMatchObject({
      source: 'evaluator_owned_common_tool_universe',
      definitionHandlerSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
    });
  });

  it.each([undefined, 'fixture_local', 'forged'])(
    'fails closed with typed provenance for missing or unknown common-universe provenance: %s',
    (provenance) => {
      const admission = admitFixedTraceCommonToolUniverse('two_stage_llm_router', provenance);
      expect(admission).toMatchObject({
        admitted: false,
        provenance: {
          source: 'evaluator_owned_common_tool_universe',
          admission: 'blocked_missing_authenticated_definition_handler_intersection',
        },
      });
      expect(admission.reasons).toContain('common_tool_universe_provenance_missing_or_unknown');
      expect(() => assertFixedTraceCommonToolUniverseAdmission('two_stage_llm_router', provenance))
        .toThrow(FixedTraceCommonToolUniverseAdmissionError);
    },
  );

  it.each([undefined, 'fixture_local', 'forged'])(
    'blocks %s provenance before provider preparation, dispatch, or handler execution',
    async (provenance) => {
    const router = new NeverDispatchProvider();
    const generation = new NeverDispatchProvider();
      const runConfig = config(router, generation, [FIXED_TRACE_SUITE[0]!]);
      runConfig.toolDefinitionProvenance = provenance as unknown as FixedTraceRunnerConfig['toolDefinitionProvenance'];
      await expect(runFixedTraceDiagnosticCandidate(runConfig))
        .rejects.toThrow(FixedTraceCommonToolUniverseAdmissionError);
      expect(router.prepare).not.toHaveBeenCalled();
      expect(router.respond).not.toHaveBeenCalled();
      expect(generation.prepare).not.toHaveBeenCalled();
      expect(generation.respond).not.toHaveBeenCalled();
    },
  );
});

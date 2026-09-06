import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
} from '../../../src/addie/eval/fixed-trace-architecture-diagnostic.js';
import { fixedTraceCommonToolDefinitions, fixedTraceHybridPolicy } from '../../../src/addie/eval/fixed-trace-architecture.js';
import { runFixedTraceArchitectureDiagnosticSuite, type FixedTraceRunnerConfig } from '../../../src/addie/eval/fixed-trace-runner.js';
import { fixedTraceSuiteSha256 } from '../../../src/addie/eval/fixed-trace-suite.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false, structuredOutput: true, reasoning: true,
  reasoningEfforts: ['provider_default', 'none'], customTools: true,
  providerWebSearch: false, imageInput: false, documentInput: false,
};

class SyntheticProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = CAPABILITIES;
  readonly requests: ModelRequest[] = [];
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({
    provider: this.id, model: request.model, capabilities: this.capabilities,
    requestMetadata: request.requestMetadata,
    providerRequest: structuredClone(request) as unknown as Record<string, unknown>,
  }));

  constructor(private readonly kind: 'router' | 'generation') {}

  async *respond(request: ModelRequest, options: ModelRespondOptions = {}): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    this.requests.push(structuredClone(request));
    const response: ModelResponse = {
      provider: this.id, model: request.model, id: `${this.kind}-${this.requests.length}`,
      content: [{ type: 'text', text: this.kind === 'router'
        ? JSON.stringify({ action: 'respond', tool_sets: [], confidence: 'high', requires_depth: false, reason: 'Synthetic router.' })
        : 'Synthetic generator response.' }],
      finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
    };
    yield { type: 'response_start', provider: this.id, model: response.model, id: response.id };
    yield { type: 'text_delta', index: 0, text: (response.content[0] as { text: string }).text };
    yield { type: 'response_complete', response };
  }
}

function stage(provider: ModelProvider, model: 'claude-haiku-4-5' | 'claude-sonnet-5') {
  return {
    provider, model, reasoningEffort: model === 'claude-sonnet-5' ? 'provider_default' as const : 'none' as const,
    maxOutputTokens: 300, timeoutMs: 30_000, maxIterations: 1,
    transportRetries: 0 as const, samplingMode: 'provider_no_sampling_control' as const, temperature: null,
    pricing: {
      profileId: model === 'claude-sonnet-5' ? 'anthropic-standard-2026-09:claude-sonnet-5' : 'anthropic-standard-2026-09:claude-haiku-4-5',
      inputUsdPerMillionTokens: model === 'claude-sonnet-5' ? 2 : 1, outputUsdPerMillionTokens: model === 'claude-sonnet-5' ? 10 : 5,
      cacheReadUsdPerMillionTokens: model === 'claude-sonnet-5' ? 0.2 : 0.1, cacheWriteUsdPerMillionTokens: model === 'claude-sonnet-5' ? 2.5 : 1.25,
      cacheReadAccounting: 'additive' as const, cacheWriteAccounting: 'additive' as const,
      source: model === 'claude-sonnet-5'
        ? 'Anthropic pricing page: Claude Sonnet 5 standard (5-minute cache write), checked 2026-09-05.'
        : 'Anthropic pricing page: Claude Haiku 4.5, checked 2026-09-05.',
    },
  };
}

function config(
  architectureArm: FixedTraceRunnerConfig['architectureArm'],
  router: ModelProvider,
  generation: ModelProvider,
): FixedTraceRunnerConfig {
  return {
    runId: `architecture-pack-${architectureArm}`, sourceBundleSha256: 'b'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
    promptConfigVersion: 'architecture-pack-test', traceSuite: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
    traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE),
    toolDefinitions: fixedTraceCommonToolDefinitions(architectureArm),
    toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm,
    architectureDiagnosticMode: 'synthetic_pack_v1',
    ...(architectureArm === 'deterministic_policy_llm_fallback_hybrid' ? { hybridPolicy: fixedTraceHybridPolicy() } : {}),
    router: stage(router, 'claude-haiku-4-5'), generation: stage(generation, 'claude-sonnet-5'),
  };
}

describe('fixed-trace architecture synthetic runner', () => {
  it('executes comparable arms on one exact pack without enabling production authority', async () => {
    const directRouter = new SyntheticProvider('router');
    const directGeneration = new SyntheticProvider('generation');
    const direct = await runFixedTraceArchitectureDiagnosticSuite(config('direct_generation', directRouter, directGeneration));

    const routedRouter = new SyntheticProvider('router');
    const routedGeneration = new SyntheticProvider('generation');
    const routed = await runFixedTraceArchitectureDiagnosticSuite(config('two_stage_llm_router', routedRouter, routedGeneration));

    const hybridRouter = new SyntheticProvider('router');
    const hybridGeneration = new SyntheticProvider('generation');
    const hybrid = await runFixedTraceArchitectureDiagnosticSuite(config('deterministic_policy_llm_fallback_hybrid', hybridRouter, hybridGeneration));

    expect(direct).toHaveLength(24);
    expect(routed).toHaveLength(24);
    expect(hybrid).toHaveLength(24);
    expect(directRouter.requests).toHaveLength(0);
    expect(directGeneration.requests).toHaveLength(24);
    expect(routedRouter.requests).toHaveLength(24);
    expect(routedGeneration.requests).toHaveLength(24);
    expect(hybridRouter.requests).toHaveLength(16);
    expect(hybridGeneration.requests).toHaveLength(16);
    expect(hybrid.filter((observation) => observation.terminalStage === 'surface')).toHaveLength(8);
    expect(direct.every((observation) => observation.routeDisposition === 'direct_surface_policy')).toBe(true);
    expect(routed.every((observation) => observation.routeDisposition === 'incumbent_llm_router')).toBe(true);
    expect(hybrid.filter((observation) => observation.terminalStage === 'surface')
      .every((observation) => observation.routeDisposition === 'reviewed_local_terminal')).toBe(true);
    expect(hybrid.filter((observation) => observation.terminalStage !== 'surface')
      .every((observation) => observation.routeDisposition === 'incumbent_llm_router')).toBe(true);

    for (const observations of [direct, routed, hybrid]) {
      for (const observation of observations) {
        expect(observation.metadata).toMatchObject({
          architectureDiagnosticMode: 'synthetic_pack_v1',
          toolDefinitionProvenance: 'evaluator_owned_common_tool_universe',
          toolUniverse: { source: 'evaluator_owned_common_tool_universe' },
          executionEnvelope: { source: 'evaluator_owned_synthetic_receipt_envelope', deployable: false },
          architectureArm: { rolloutEligible: false, diagnosticOnly: true },
        });
      }
    }
    expect(direct.every((observation) => observation.metadata.router.source === 'not_run')).toBe(true);
    expect(direct.every((observation) => observation.metadata.directArmAdmission?.admitted === false)).toBe(true);
    const toolNames = directGeneration.requests[0]!.tools.map((tool) => tool.name);
    expect([...directGeneration.requests, ...routedGeneration.requests, ...hybridGeneration.requests]
      .every((request) => request.model === 'claude-sonnet-5')).toBe(true);
    expect([...routedGeneration.requests, ...hybridGeneration.requests]
      .every((request) => request.tools.map((tool) => tool.name).join(',') === toolNames.join(','))).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE,
  FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
  fixedTraceArchitectureDiagnosticPilotStageControls,
  fixedTraceArchitectureDiagnosticStageControls,
} from '../../../src/addie/eval/fixed-trace-architecture-diagnostic.js';
import { fixedTraceCommonToolDefinitions, fixedTraceHybridPolicy } from '../../../src/addie/eval/fixed-trace-architecture.js';
import {
  runFixedTraceArchitectureDiagnosticPilot,
  runFixedTraceArchitectureDiagnosticSuite,
  type FixedTraceRunnerConfig,
} from '../../../src/addie/eval/fixed-trace-runner.js';
import {
  fixedTraceArchitectureConfigSha256FromMetadata,
  fixedTraceSuiteSha256,
  summarizeFixedTraceRun,
} from '../../../src/addie/eval/fixed-trace-suite.js';
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
  readonly capabilities = CAPABILITIES;
  readonly requests: ModelRequest[] = [];
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({
    provider: this.id, model: request.model, capabilities: this.capabilities,
    requestMetadata: request.requestMetadata,
    providerRequest: structuredClone(request) as unknown as Record<string, unknown>,
  }));

  constructor(
    private readonly kind: 'router' | 'generation',
    readonly id: 'anthropic' | 'openai' = 'anthropic',
  ) {}

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

function config(
  architectureArm: FixedTraceRunnerConfig['architectureArm'],
  router: ModelProvider,
  generation: ModelProvider,
  routerKind: 'haiku' | 'luna' = 'haiku',
): FixedTraceRunnerConfig {
  const controls = fixedTraceArchitectureDiagnosticStageControls(routerKind);
  return {
    runId: `architecture-pack-${architectureArm}`, sourceBundleSha256: 'b'.repeat(64), gitCommit: 'abcdef0', gitDirty: false,
    promptConfigVersion: 'architecture-pack-test', traceSuite: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE,
    traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_SUITE),
    toolDefinitions: fixedTraceCommonToolDefinitions(architectureArm),
    toolDefinitionProvenance: 'evaluator_owned_common_tool_universe', architectureArm,
    architectureDiagnosticMode: 'synthetic_pack_v1',
    ...(architectureArm === 'deterministic_policy_llm_fallback_hybrid' ? { hybridPolicy: fixedTraceHybridPolicy() } : {}),
    router: { ...controls.router, provider: router }, generation: { ...controls.generation, provider: generation },
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

    const lunaRouter = new SyntheticProvider('router', 'openai');
    const lunaGeneration = new SyntheticProvider('generation');
    const luna = await runFixedTraceArchitectureDiagnosticSuite(
      config('two_stage_llm_router', lunaRouter, lunaGeneration, 'luna'),
    );

    expect(direct).toHaveLength(24);
    expect(routed).toHaveLength(24);
    expect(hybrid).toHaveLength(24);
    expect(luna).toHaveLength(24);
    expect(directRouter.requests).toHaveLength(0);
    expect(directGeneration.requests).toHaveLength(24);
    expect(routedRouter.requests).toHaveLength(24);
    expect(routedGeneration.requests).toHaveLength(24);
    expect(hybridRouter.requests).toHaveLength(16);
    expect(hybridGeneration.requests).toHaveLength(16);
    expect(lunaRouter.requests).toHaveLength(24);
    expect(lunaGeneration.requests).toHaveLength(24);
    expect(lunaRouter.requests.every((request) => request.model === 'gpt-5.6-luna')).toBe(true);
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
        expect(observation.metadata.architectureDiagnostic).toMatchObject({
          packDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          pilotDigest: null,
          clusterId: expect.stringMatching(/^architecture-cluster-0[1-8]$/),
          stratum: expect.any(String),
          localNearPairId: expect.any(String),
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

  it('runs only the exact pilot triplet and rejects reordered or over-limit candidate controls before provider dispatch', async () => {
    const pilotConfig = (
      architectureArm: FixedTraceRunnerConfig['architectureArm'],
      router: ModelProvider,
      generation: ModelProvider,
    ): FixedTraceRunnerConfig => ({
      ...config(architectureArm, router, generation),
      runId: `architecture-pilot-${architectureArm}`,
      traceSuite: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE,
      traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE),
      architectureDiagnosticMode: 'synthetic_pilot_v1',
      router: { ...fixedTraceArchitectureDiagnosticPilotStageControls().router, provider: router },
      generation: { ...fixedTraceArchitectureDiagnosticPilotStageControls().generation, provider: generation },
    });
    const directRouter = new SyntheticProvider('router');
    const directGeneration = new SyntheticProvider('generation');
    const direct = await runFixedTraceArchitectureDiagnosticPilot(
      pilotConfig('direct_generation', directRouter, directGeneration),
    );
    const routedRouter = new SyntheticProvider('router');
    const routedGeneration = new SyntheticProvider('generation');
    const routed = await runFixedTraceArchitectureDiagnosticPilot(
      pilotConfig('two_stage_llm_router', routedRouter, routedGeneration),
    );
    const hybridRouter = new SyntheticProvider('router');
    const hybridGeneration = new SyntheticProvider('generation');
    const hybrid = await runFixedTraceArchitectureDiagnosticPilot(
      pilotConfig('deterministic_policy_llm_fallback_hybrid', hybridRouter, hybridGeneration),
    );

    expect(direct).toHaveLength(3);
    expect(routed).toHaveLength(3);
    expect(hybrid).toHaveLength(3);
    expect(directRouter.requests).toHaveLength(0);
    expect(directGeneration.requests).toHaveLength(3);
    expect(routedRouter.requests).toHaveLength(3);
    expect(routedGeneration.requests).toHaveLength(3);
    expect(hybridRouter.requests).toHaveLength(2);
    expect(hybridGeneration.requests).toHaveLength(2);
    expect(hybrid.filter((observation) => observation.terminalStage === 'surface')).toHaveLength(1);
    expect(hybrid.every((observation) => observation.metadata.architectureDiagnostic?.pilotDigest
      && observation.metadata.architectureDiagnostic.clusterId === 'architecture-cluster-01'
      && observation.metadata.architectureDiagnostic.localNearPairId === 'local-near-01')).toBe(true);

    const hostileRouter = new SyntheticProvider('router');
    const hostileGeneration = new SyntheticProvider('generation');
    const reorderedSuite = [...FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE].reverse();
    const reordered: FixedTraceRunnerConfig = {
      ...pilotConfig('direct_generation', hostileRouter, hostileGeneration),
      traceSuite: reorderedSuite,
      traceSuiteSha256: fixedTraceSuiteSha256(reorderedSuite),
    };
    await expect(runFixedTraceArchitectureDiagnosticPilot(reordered))
      .rejects.toThrow('differs from the predeclared synthetic pilot');
    expect(hostileRouter.requests).toHaveLength(0);
    expect(hostileGeneration.requests).toHaveLength(0);

    const excessive = pilotConfig('two_stage_llm_router', hostileRouter, hostileGeneration);
    excessive.generation = { ...excessive.generation, maxIterations: 3 };
    await expect(runFixedTraceArchitectureDiagnosticPilot(excessive))
      .rejects.toThrow('differs from reviewed candidate controls');
    expect(hostileRouter.requests).toHaveLength(0);
    expect(hostileGeneration.requests).toHaveLength(0);
  });

  it('refuses any non-builder-owned full-pack stage cell before provider dispatch', async () => {
    const mutations: Array<(value: FixedTraceRunnerConfig) => void> = [
      (value) => { value.generation = { ...value.generation, model: 'claude-haiku-4-5' }; },
      (value) => { value.generation = { ...value.generation, provider: new SyntheticProvider('generation', 'openai') }; },
      (value) => { value.generation = { ...value.generation, reasoningEffort: 'none' }; },
      (value) => { value.router = { ...value.router, reasoningEffort: 'none' }; },
      (value) => { value.router = { ...value.router, pricing: { ...value.router.pricing, inputUsdPerMillionTokens: 999 } }; },
      (value) => { value.generation = { ...value.generation, maxOutputTokens: value.generation.maxOutputTokens + 1 }; },
      (value) => { value.generation = { ...value.generation, maxIterations: value.generation.maxIterations - 1 }; },
    ];
    for (const mutate of mutations) {
      const router = new SyntheticProvider('router');
      const generation = new SyntheticProvider('generation');
      const hostile = config('direct_generation', router, generation);
      mutate(hostile);
      await expect(runFixedTraceArchitectureDiagnosticSuite(hostile))
        .rejects.toThrow('differs from builder-owned exact stage controls');
      expect(router.requests).toHaveLength(0);
      expect(generation.requests).toHaveLength(0);
    }
  });

  it.each([
    ['cluster', 'clusterId', 'forged-cluster'],
    ['stratum', 'stratum', 'routed_tool_or_safety'],
    ['local/near pair', 'localNearPairId', 'forged-pair'],
    ['pack digest', 'packDigest', '0'.repeat(64)],
    ['pilot digest', 'pilotDigest', '0'.repeat(64)],
  ] as const)('rejects post-execution forged pilot %s provenance', async (_name, field, value) => {
    const router = new SyntheticProvider('router');
    const generation = new SyntheticProvider('generation');
    const controls = fixedTraceArchitectureDiagnosticPilotStageControls();
    const observations = await runFixedTraceArchitectureDiagnosticPilot({
      ...config('direct_generation', router, generation),
      runId: `architecture-pilot-forged-${field}`,
      traceSuite: FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE,
      traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE),
      architectureDiagnosticMode: 'synthetic_pilot_v1',
      router: { ...controls.router, provider: router },
      generation: { ...controls.generation, provider: generation },
    });
    const forged = structuredClone(observations);
    const provenance = forged[0]!.metadata.architectureDiagnostic!;
    (provenance as Record<string, string | null>)[field] = value;
    // Recompute the public cohort hash to prove the artifact validator, rather
    // than object immutability or a stale hash, rejects this altered payload.
    forged[0]!.metadata.architectureConfigSha256 = fixedTraceArchitectureConfigSha256FromMetadata(forged[0]!.metadata);
    expect(() => summarizeFixedTraceRun(forged, FIXED_TRACE_ARCHITECTURE_DIAGNOSTIC_PILOT_SUITE))
      .toThrow('diagnostic observation provenance does not match its canonical mapping');
  });
});

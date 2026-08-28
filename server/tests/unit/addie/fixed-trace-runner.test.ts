import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  fixedTraceToolSchemaSha256,
  runFixedTraceCase,
  type FixedTraceProviderStageConfig,
  type FixedTraceRunnerConfig,
} from '../../../src/addie/eval/fixed-trace-runner.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import {
  FIXED_TRACE_SUITE,
  gradeFixedTrace,
  type FixedTraceCase,
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
import type { AddieTool } from '../../../src/addie/types.js';

const HASH = createHash('sha256').update('fixed-trace-runner-test').digest('hex');

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

class ScriptedProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities: ModelProviderCapabilities;
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({
    provider: this.id,
    model: request.model,
    capabilities: this.capabilities,
    requestMetadata: request.requestMetadata,
    providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
  }));
  readonly respondCalls: ModelRequest[] = [];

  constructor(
    private readonly script: Array<ModelResponse | Error>,
    capabilities: ModelProviderCapabilities = CAPABILITIES,
  ) {
    this.capabilities = capabilities;
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    this.respondCalls.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('Script exhausted');
    if (next instanceof Error) throw next;
    yield { type: 'response_start', provider: this.id, model: next.model, id: next.id };
    for (const [index, item] of next.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
      else if (item.type === 'tool_call') yield { type: 'tool_call', index, call: item };
      else if (item.type === 'provider_state') yield { type: 'provider_state', index, state: item };
      else if (item.type === 'provider_tool_call') yield { type: 'provider_tool_call', index, call: item };
      else if (item.type === 'provider_tool_result') yield { type: 'provider_tool_result', index, result: item };
    }
    yield { type: 'response_complete', response: next };
  }
}

function response(
  content: ModelResponse['content'],
  finishReason: ModelResponse['finishReason'] = 'stop',
  id = 'response',
): ModelResponse {
  return {
    provider: 'anthropic',
    model: 'test-model',
    id,
    content,
    finishReason,
    providerFinishReason: finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function routeResponse(action: 'ignore' | 'respond', toolSets: string[] = []): ModelResponse {
  return response([{
    type: 'text',
    text: action === 'ignore'
      ? JSON.stringify({ action: 'ignore', reason: 'Synthetic route.' })
      : JSON.stringify({
          action: 'respond',
          tool_sets: toolSets,
          confidence: 'high',
          requires_depth: false,
          reason: 'Synthetic route.',
        }),
  }], 'stop', 'router-response');
}

function tool(name: string): AddieTool {
  return {
    name,
    description: `Canonical ${name} schema.`,
    replaySafety: name === 'confirm_send_invoice' ? 'mutation' : 'pure_local',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        invoice_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  };
}

const TOOL_DEFINITIONS = [
  'search_docs',
  'get_doc',
  'get_my_profile',
  'find_duplicate_orgs',
  'send_invoice',
  'confirm_send_invoice',
].map(tool);

function stage(provider: ModelProvider, maxIterations: number): FixedTraceProviderStageConfig {
  return {
    provider,
    model: 'test-model',
    reasoningEffort: 'none',
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing: {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      source: 'Synthetic test pricing.',
    },
  };
}

function config(
  router: ModelProvider,
  generation: ModelProvider,
  overrides: Partial<FixedTraceRunnerConfig> = {},
): FixedTraceRunnerConfig {
  return {
    runId: 'fixed-run-test',
    sourceBundleSha256: HASH,
    gitCommit: 'abcdef0',
    gitDirty: false,
    promptConfigVersion: 'synthetic-prompt-v1',
    toolDefinitions: TOOL_DEFINITIONS,
    router: stage(router, 1),
    generation: stage(generation, 3),
    ...overrides,
  };
}

function trace(id: string): FixedTraceCase {
  const selected = FIXED_TRACE_SUITE.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`Missing trace ${id}`);
  return selected;
}

describe('fixed trace artifact runner', () => {
  it('records complete router and multi-turn generation provenance', async () => {
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call',
        id: 'tool-1',
        name: 'search_docs',
        input: { query: 'task model' },
      }], 'tool_calls', 'generation-tool'),
      response([{ type: 'text', text: 'The protocol uses task-based requests.' }], 'stop', 'generation-final'),
    ]);
    const selectedTrace = trace('knowledge-task-model');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      traceId: selectedTrace.id,
      terminalStage: 'generation',
      terminalStatus: 'complete',
      finishReason: 'stop',
      output: 'The protocol uses task-based requests.',
      route: { action: 'respond', toolSets: ['knowledge'] },
      flagged: false,
      tools: [{
        name: 'search_docs',
        effect: 'read',
        policyDisposition: 'allowed',
        resultStatus: 'ok',
        simulated: true,
      }],
    });
    expect(observation.metadata.router).toMatchObject({
      source: 'provider',
      dispatched: true,
      usage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.000035,
    });
    expect(observation.metadata.generation).toMatchObject({
      source: 'provider',
      dispatched: true,
      usage: { inputTokens: 20, outputTokens: 10 },
      estimatedCostUsd: 0.00007,
    });
    expect(observation.metadata.generation.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generation.respondCalls).toHaveLength(2);
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({
      deterministicPass: true,
      metadataPass: true,
    });
  });

  it('stops at the surface decision without dispatching generation', async () => {
    const router = new ScriptedProvider([routeResponse('ignore')]);
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('surface-channel-chatter');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      terminalStage: 'surface',
      terminalStatus: 'ignored',
      route: { action: 'ignore', toolSets: [] },
      metadata: { generation: { source: 'not_run', dispatched: false } },
    });
    expect(generation.respondCalls).toHaveLength(0);
    expect(gradeFixedTrace(selectedTrace, observation).deterministicPass).toBe(true);
  });

  it('omits provider-default reasoning from adapters without reasoning support', async () => {
    const router = new ScriptedProvider([routeResponse('ignore')], {
      ...CAPABILITIES,
      reasoning: false,
      reasoningEfforts: [],
    });
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('surface-channel-chatter');
    const runConfig = config(router, generation);
    runConfig.router.reasoningEffort = 'provider_default';

    await runFixedTraceCase(selectedTrace, runConfig);

    expect(router.respondCalls[0].reasoning).toBeUndefined();
  });

  it('records budget admission refusal as not dispatched', async () => {
    const delegate = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const budget = new FixedTraceBudget(0.000001);
    const router = new BudgetedFixedTraceProvider(delegate, budget, {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      source: 'Synthetic test pricing.',
    });
    const generation = new ScriptedProvider([]);

    const observation = await runFixedTraceCase(
      trace('knowledge-task-model'),
      config(router, generation),
    );

    expect(observation).toMatchObject({
      terminalStage: 'router',
      terminalStatus: 'not_dispatched_budget',
      output: '',
      flagged: true,
      metadata: {
        router: {
          source: 'local',
          dispatched: false,
          estimatedCostUsd: 0,
        },
      },
    });
    expect(delegate.respondCalls).toHaveLength(0);
    expect(gradeFixedTrace(trace('knowledge-task-model'), observation).metadataPass).toBe(true);
  });

  it('attributes malformed router output to the router and preserves its cost', async () => {
    const router = new ScriptedProvider([response([{ type: 'text', text: 'not-json' }])]);
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('knowledge-task-model');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));
    const grade = gradeFixedTrace(selectedTrace, observation);

    expect(observation).toMatchObject({
      terminalStage: 'router',
      terminalStatus: 'malformed',
      route: null,
      output: 'not-json',
      metadata: {
        router: { source: 'provider', usageKnown: true, estimatedCostUsd: 0.000035 },
        generation: { source: 'not_run' },
      },
    });
    expect(grade.metadataPass).toBe(true);
    expect(grade.failures).not.toContain('terminal_stage_mismatch');
    expect(grade.failures).not.toContain('failure_stage_mismatch');
  });

  it('injects the provider-degradation fixture without a paid dispatch', async () => {
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('provider-unavailable');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      terminalStage: 'generation',
      terminalStatus: 'provider_error',
      output: expect.stringContaining('temporarily unavailable'),
      flagged: true,
      metadata: {
        generation: {
          source: 'local',
          dispatched: false,
          usageKnown: false,
          estimatedCostUsd: 0,
        },
      },
    });
    expect(generation.respondCalls).toHaveLength(0);
    expect(generation.prepare).toHaveBeenCalledOnce();
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({
      deterministicPass: true,
      metadataPass: true,
    });
  });

  it('keeps a dispatched malformed tool turn in the denominator with unknown cost', async () => {
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([response([{
      type: 'tool_call',
      id: 'tool-1',
      name: 'unknown_tool',
      input: {},
    }], 'tool_calls')]);
    const selectedTrace = trace('knowledge-task-model');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      terminalStage: 'generation',
      terminalStatus: 'malformed',
      metadata: {
        generation: {
          source: 'local',
          dispatched: true,
          usageKnown: false,
          estimatedCostUsd: null,
          pricingSource: null,
        },
      },
    });
    expect(observation.metadata.generation.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes exactly the canonical fixed-trace tool subset', () => {
    expect(fixedTraceToolSchemaSha256(TOOL_DEFINITIONS)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => fixedTraceToolSchemaSha256(TOOL_DEFINITIONS.slice(1))).toThrow('incomplete or duplicated');
  });
});

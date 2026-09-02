import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFixedTraceGenerationRequest,
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
  mutationInputProvenanceFailures,
  type FixedTraceCase,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import { FAILED_LOOKUP_EVIDENCE_RESPONSE } from '../../../src/addie/failed-lookup-evidence.js';
import { MEETING_TOOLS as CANONICAL_MEETING_TOOLS } from '../../../src/addie/mcp/meeting-tools.js';
import { MEMBER_TOOLS } from '../../../src/addie/mcp/member-tools.js';
import { KNOWLEDGE_TOOLS } from '../../../src/addie/mcp/knowledge-search.js';
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

const CANONICAL_COMMUNITY_GROUP_TOOLS = [...MEMBER_TOOLS, ...KNOWLEDGE_TOOLS].filter((definition) => [
  'list_working_groups', 'get_working_group', 'join_working_group', 'request_working_group_invitation',
  'get_my_working_groups', 'express_council_interest', 'withdraw_council_interest', 'get_my_council_interests',
  'create_working_group_post', 'bookmark_resource', 'list_committee_documents',
].includes(definition.name));

const TOOL_DEFINITIONS = [
  'search_docs',
  'get_doc',
  'get_my_profile',
  'find_duplicate_orgs',
  'send_invoice',
  'confirm_send_invoice',
].map(tool).concat(CANONICAL_MEETING_TOOLS, CANONICAL_COMMUNITY_GROUP_TOOLS);

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
      response([{
        type: 'text',
        text: 'A buyer calls a defined task on the seller with structured input, and the seller returns the task response.',
      }], 'stop', 'generation-final'),
    ]);
    const selectedTrace = trace('knowledge-task-model');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      traceId: selectedTrace.id,
      terminalStage: 'generation',
      terminalStatus: 'complete',
      boundaryReason: null,
      localReplacementReason: null,
      finishReason: 'stop',
      output: 'A buyer calls a defined task on the seller with structured input, and the seller returns the task response.',
      route: { action: 'respond', toolSets: ['knowledge'] },
      flagged: false,
      tools: [{
        name: 'search_docs',
        description: 'Canonical search_docs schema.',
        input: { query: 'task model' },
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
    expect(generation.respondCalls[0].toolChoice).toEqual({ type: 'tool', name: 'search_docs' });
    expect(generation.respondCalls[1].toolChoice).toBeUndefined();
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({
      deterministicPass: true,
      metadataPass: true,
    });
  });

  it('replays four requested long-meeting mutations through canonical schemas', async () => {
    const selectedTrace = trace('meeting-full-administration-confirmed');
    const router = new ScriptedProvider([routeResponse('respond', ['meeting_full_administration'])]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call',
        id: 'meeting-tool-1',
        name: 'schedule_meeting',
        input: {
          working_group_slug: 'governance',
          title: 'Quarterly governance meeting',
          start_time: '2026-09-03T14:00:00-04:00',
          timezone: 'America/New_York',
          recurrence: { freq: 'weekly', by_day: ['TH'], count: 12 },
        },
      }], 'tool_calls', 'meeting-schedule'),
      response([{
        type: 'tool_call',
        id: 'meeting-tool-2',
        name: 'add_meeting_attendee',
        input: { meeting_id: 'synthetic-meeting-1', email: 'new-attendee-at-synthetic-invalid', add_to_series: true },
      }], 'tool_calls', 'meeting-attendee'),
      response([{
        type: 'tool_call',
        id: 'meeting-tool-3',
        name: 'rsvp_to_meeting',
        input: { meeting_id: 'synthetic-meeting-1', response: 'accepted' },
      }], 'tool_calls', 'meeting-rsvp'),
      response([{
        type: 'tool_call',
        id: 'meeting-tool-4',
        name: 'update_topic_subscriptions',
        input: { working_group_slug: 'governance', topic_slugs: ['governance'] },
      }], 'tool_calls', 'meeting-topics'),
      response([{
        type: 'text',
        text: 'Scheduled the recurring meeting, added the attendee, recorded the RSVP, and updated topic subscriptions.',
      }], 'stop', 'meeting-final'),
    ]);

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      generation: stage(generation, 5),
    }));

    expect(generation.respondCalls).toHaveLength(5);
    expect(generation.respondCalls[0]?.tools.map((definition) => definition.name)).toEqual(
      selectedTrace.toolFixtures.map((fixture) => fixture.name),
    );
    expect(observation.tools.map((execution) => execution.name)).toEqual([
      'schedule_meeting', 'add_meeting_attendee', 'rsvp_to_meeting', 'update_topic_subscriptions',
    ]);
    expect(observation.tools.every((execution) => execution.policyDisposition === 'allowed' && execution.simulated)).toBe(true);
    expect(mutationInputProvenanceFailures(selectedTrace, observation.tools)).toEqual([]);
    const inventedInput = structuredClone(observation.tools);
    inventedInput[3]!.input = { working_group_slug: 'governance', topic_slugs: ['invented-topic'] };
    expect(mutationInputProvenanceFailures(selectedTrace, inventedInput)).toEqual([
      'update_topic_subscriptions:$.topic_slugs[0]',
    ]);
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({ deterministicPass: true });
    expect(gradeFixedTrace(selectedTrace, { ...observation, tools: inventedInput })).toMatchObject({
      deterministicPass: false,
      mutationSafetyPass: false,
      failures: expect.arrayContaining(['mutation_input_provenance_mismatch']),
    });
  });

  it('replays only the confirmed community-group mutations through canonical schemas', async () => {
    const selectedTrace = trace('community-group-full-participation-confirmed');
    const router = new ScriptedProvider([routeResponse('respond', ['community_group_full_participation'])]);
    const generation = new ScriptedProvider([
      response([{ type: 'tool_call', id: 'group-tool-1', name: 'list_working_groups', input: { type: 'all' } }], 'tool_calls', 'group-list'),
      response([{ type: 'tool_call', id: 'group-tool-2', name: 'get_working_group', input: { slug: 'measurement' } }], 'tool_calls', 'group-get'),
      response([{ type: 'tool_call', id: 'group-tool-3', name: 'join_working_group', input: { slug: 'measurement' } }], 'tool_calls', 'group-join'),
      response([{ type: 'tool_call', id: 'group-tool-4', name: 'express_council_interest', input: { slug: 'retail-media', interest_level: 'participant' } }], 'tool_calls', 'group-interest'),
      response([{ type: 'tool_call', id: 'group-tool-5', name: 'create_working_group_post', input: { working_group_slug: 'measurement', title: 'Synthetic measurement update', content: 'Please review the synthetic measurement draft.', post_type: 'discussion' } }], 'tool_calls', 'group-post'),
      response([{ type: 'text', text: 'Joined measurement, recorded participant interest in retail-media, and created the requested post.' }], 'stop', 'group-final'),
    ]);

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      generation: stage(generation, 6),
    }));

    expect(generation.respondCalls).toHaveLength(6);
    expect(generation.respondCalls[0]?.tools.map((definition) => definition.name)).toEqual(
      selectedTrace.toolFixtures.map((fixture) => fixture.name),
    );
    expect(observation.tools.map((execution) => execution.name)).toEqual([
      'list_working_groups', 'get_working_group', 'join_working_group', 'express_council_interest', 'create_working_group_post',
    ]);
    expect(mutationInputProvenanceFailures(selectedTrace, observation.tools)).toEqual([]);
    const inventedInput = structuredClone(observation.tools);
    inventedInput[4]!.input = { working_group_slug: 'measurement', title: 'Synthetic measurement update', content: 'Invented post body', post_type: 'discussion' };
    expect(mutationInputProvenanceFailures(selectedTrace, inventedInput)).toEqual([
      'create_working_group_post:$.content',
    ]);
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({ deterministicPass: true });
    expect(gradeFixedTrace(selectedTrace, { ...observation, tools: inventedInput })).toMatchObject({
      deterministicPass: false,
      mutationSafetyPass: false,
      failures: expect.arrayContaining(['mutation_input_provenance_mismatch']),
    });
  });

  it('fails closed when the full community-group trace attempts an extra unrequested post', async () => {
    const selectedTrace = trace('community-group-full-participation-confirmed');
    const router = new ScriptedProvider([routeResponse('respond', ['community_group_full_participation'])]);
    const generation = new ScriptedProvider([
      response([{ type: 'tool_call', id: 'group-tool-1', name: 'list_working_groups', input: { type: 'all' } }], 'tool_calls', 'group-list'),
      response([{ type: 'tool_call', id: 'group-tool-2', name: 'create_working_group_post', input: { working_group_slug: 'measurement', title: 'Synthetic measurement update', content: 'Please review the synthetic measurement draft.', post_type: 'discussion' } }], 'tool_calls', 'group-post'),
      response([{ type: 'tool_call', id: 'group-tool-3', name: 'create_working_group_post', input: { working_group_slug: 'measurement', title: 'Synthetic measurement update', content: 'Please review the synthetic measurement draft.', post_type: 'discussion' } }], 'tool_calls', 'group-extra-post'),
    ]);

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      generation: stage(generation, 4),
    }));

    expect(observation).toMatchObject({
      terminalStatus: 'malformed',
      boundaryReason: 'duplicate_tool_call',
      flagged: true,
      tools: [],
    });
  });

  it('forces official-doc retrieval only when the exact knowledge route exposes search_docs', () => {
    const selectedTrace = trace('knowledge-task-model');
    const exactKnowledge = buildFixedTraceGenerationRequest(
      selectedTrace,
      { action: 'respond', tool_sets: ['knowledge'], confidence: 'high', requires_depth: false, reason: 'docs' },
      [tool('search_docs'), tool('get_doc')],
      stage(new ScriptedProvider([]), 3),
    );
    const mixedRoute = buildFixedTraceGenerationRequest(
      selectedTrace,
      { action: 'respond', tool_sets: ['knowledge', 'schema_reference'], confidence: 'high', requires_depth: false, reason: 'schema' },
      [tool('search_docs'), tool('get_doc')],
      stage(new ScriptedProvider([]), 3),
    );
    const noBoundary = buildFixedTraceGenerationRequest(
      selectedTrace,
      { action: 'respond', tool_sets: ['knowledge'], confidence: 'high', requires_depth: false, reason: 'docs' },
      [tool('get_doc')],
      stage(new ScriptedProvider([]), 3),
    );

    expect(exactKnowledge.toolChoice).toEqual({ type: 'tool', name: 'search_docs' });
    expect(mixedRoute.toolChoice).toBeUndefined();
    expect(noBoundary.toolChoice).toBeUndefined();
    expect(exactKnowledge.system[0]?.text).not.toContain('# Knowledge');
    expect(exactKnowledge.system[1]?.text).toContain('# Knowledge');
    expect(exactKnowledge.system[1]?.text).toContain('## Knowledge Search First');
    expect(exactKnowledge.system.at(-1)?.text).toContain('# Constraints');
    expect(exactKnowledge.system.at(-1)?.text).toContain('# Response Style');
  });

  it('records a local replacement when every source lookup fails', async () => {
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call',
        id: 'tool-1',
        name: 'search_docs',
        input: { query: 'package identifiers' },
      }], 'tool_calls', 'generation-tool'),
      response([{
        type: 'text',
        text: 'The documentation confirms it. See https://invented.example/docs.',
      }], 'stop', 'generation-final'),
    ]);
    const selectedTrace = trace('knowledge-tool-error');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation).toMatchObject({
      terminalStage: 'generation',
      terminalStatus: 'complete',
      boundaryReason: null,
      localReplacementReason: 'failed_lookup_evidence',
      output: FAILED_LOOKUP_EVIDENCE_RESPONSE,
      flagged: true,
      tools: [{
        name: 'search_docs',
        resultStatus: 'recoverable_error',
      }],
    });
    expect(observation.output).not.toContain('invented.example');
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({
      deterministicPass: true,
      answerPass: true,
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

  it('accepts the synthetic loop ceiling for the full provider-visible meeting union', async () => {
    const router = new ScriptedProvider([routeResponse('ignore')]);
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('surface-channel-chatter');

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      router: stage(router, 12),
      generation: stage(generation, 12),
    }));

    expect(observation.terminalStatus).toBe('ignored');
    expect(generation.respondCalls).toHaveLength(0);
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
      boundaryReason: 'unknown_tool_call',
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

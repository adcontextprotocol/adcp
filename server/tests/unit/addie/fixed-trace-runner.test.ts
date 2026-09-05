import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import {
  assertFixedTraceArchitectureComparisonPrerequisite,
  buildFixedTraceGenerationRequest,
  fixedTraceArchitectureConfigSha256,
  fixedTraceToolSchemaSha256,
  runFixedTraceCase,
  runFixedTraceSuite,
  type FixedTraceProviderStageConfig,
  type FixedTraceRunnerConfig,
} from '../../../src/addie/eval/fixed-trace-runner.js';
import { runFixedTraceDiagnosticCandidate } from '../../../src/addie/eval/fixed-trace-diagnostic-run.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceResponsePricingPolicy,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_HYBRID_EVALUATOR_SUITE,
  FIXED_TRACE_HYBRID_MINIMUM_LOCAL_ADMISSIONS,
  fixedTraceArchitectureConfigSha256FromMetadata,
  fixedTraceSuiteSha256,
  gradeFixedTrace,
  mutationInputProvenanceFailures,
  summarizeFixedTraceRun,
  type FixedTraceCase,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import {
  admitFixedTraceDirectArm,
  decideFixedTraceHybridRoute,
  deriveFixedTraceDirectToolUniverse,
  FixedTraceHybridAdmissionSnapshotError,
  fixedTraceHybridPolicy,
} from '../../../src/addie/eval/fixed-trace-architecture.js';
import { FIXED_TRACE_DIRECT_TOOL_UNIVERSE } from '../../../src/addie/direct-tool-universe.js';
import { FAILED_LOOKUP_EVIDENCE_RESPONSE } from '../../../src/addie/failed-lookup-evidence.js';
import { ADMIN_TOOLS } from '../../../src/addie/mcp/admin-tools.js';
import { BRAND_CANONICAL_TOOLS } from '../../../src/addie/mcp/brand-canonical-tools.js';
import { DIRECTORY_TOOLS } from '../../../src/addie/mcp/directory-tools.js';
import { MEETING_TOOLS as CANONICAL_MEETING_TOOLS } from '../../../src/addie/mcp/meeting-tools.js';
import { MEMBER_TOOLS } from '../../../src/addie/mcp/member-tools.js';
import { KNOWLEDGE_TOOLS } from '../../../src/addie/mcp/knowledge-search.js';
import { PROPERTY_TOOLS } from '../../../src/addie/mcp/property-tools.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';
import { UnsupportedModelCapabilityError } from '../../../src/addie/model-providers/model-provider.js';
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
    protected readonly script: Array<ModelResponse | Error>,
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

class DeferredBeforeDispatchProvider extends ScriptedProvider {
  private releaseDispatch!: () => void;
  private readonly dispatchReleased = new Promise<void>((resolve) => { this.releaseDispatch = resolve; });
  private signalBeforeDispatch!: () => void;
  readonly beforeDispatchPending = new Promise<void>((resolve) => { this.signalBeforeDispatch = resolve; });

  release(): void {
    this.releaseDispatch();
  }

  override async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    this.signalBeforeDispatch();
    await this.dispatchReleased;
    await options.beforeDispatch?.(prepared);
    this.respondCalls.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('Script exhausted');
    if (next instanceof Error) throw next;
    yield { type: 'response_start', provider: this.id, model: next.model, id: next.id };
    for (const [index, item] of next.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
    }
    yield { type: 'response_complete', response: next };
  }
}

class DeferredContinuationProvider extends ScriptedProvider {
  private dispatchCount = 0;
  private releaseDispatch!: () => void;
  private readonly dispatchReleased = new Promise<void>((resolve) => { this.releaseDispatch = resolve; });
  private signalBeforeContinuation!: () => void;
  readonly beforeContinuationPending = new Promise<void>((resolve) => { this.signalBeforeContinuation = resolve; });

  release(): void {
    this.releaseDispatch();
  }

  override async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    this.dispatchCount += 1;
    if (this.dispatchCount === 2) {
      this.signalBeforeContinuation();
      await this.dispatchReleased;
    }
    await options.beforeDispatch?.(prepared);
    this.respondCalls.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('Script exhausted');
    if (next instanceof Error) throw next;
    yield { type: 'response_start', provider: this.id, model: next.model, id: next.id };
    for (const [index, item] of next.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
      else if (item.type === 'tool_call') yield { type: 'tool_call', index, call: item };
    }
    yield { type: 'response_complete', response: next };
  }
}

class MutatingResponseProvider extends ScriptedProvider {
  constructor(
    script: Array<ModelResponse | Error>,
    private readonly mutateAfterDispatch: () => void,
  ) {
    super(script);
  }

  override async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    const prepared = this.prepare(request);
    await options.beforeDispatch?.(prepared);
    this.respondCalls.push(structuredClone(request));
    this.mutateAfterDispatch();
    const next = this.script.shift();
    if (!next) throw new Error('Script exhausted');
    if (next instanceof Error) throw next;
    yield { type: 'response_start', provider: this.id, model: next.model, id: next.id };
    for (const [index, item] of next.content.entries()) {
      if (item.type === 'text') yield { type: 'text_delta', index, text: item.text };
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
    model: 'claude-haiku-4-5',
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

const CANONICAL_ADMIN_MEMBER_RECORDS_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'list_paying_members',
  'list_slack_users_by_org',
].includes(definition.name));

const CANONICAL_ADMIN_BRAND_LOGO_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'list_pending_brand_logos',
].includes(definition.name));

const CANONICAL_ADMIN_BILLING_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'list_pending_invoices',
].includes(definition.name));

const CANONICAL_ADMIN_PROSPECT_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'query_prospects',
].includes(definition.name));

const CANONICAL_ADMIN_FEED_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'list_feed_proposals',
].includes(definition.name));

const CANONICAL_ADMIN_WORKFLOW_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'my_upcoming_tasks',
].includes(definition.name));

const CANONICAL_ADCP_AGENT_MANAGEMENT_TOOLS = MEMBER_TOOLS.filter((definition) => [
  'list_saved_agents',
].includes(definition.name));

const CANONICAL_OUTREACH_REPORTING_TOOLS = ADMIN_TOOLS.filter((definition) => [
  'get_action_items',
].includes(definition.name));

const CANONICAL_BRAND_IDENTITY_TOOLS = BRAND_CANONICAL_TOOLS.filter((definition) => [
  'check_mutual_assertion',
].includes(definition.name));

const CANONICAL_AGENT_PUBLISHER_DIRECTORY_TOOLS = DIRECTORY_TOOLS.filter((definition) => [
  'list_agents',
].includes(definition.name));

const CANONICAL_PROPERTY_IDENTIFIER_CATALOG_TOOLS = PROPERTY_TOOLS.filter((definition) => [
  'browse_catalog',
].includes(definition.name));

const TOOL_DEFINITIONS = [
  'search_docs',
  'search_slack',
  'get_doc',
  'get_my_profile',
  'get_company_listing',
  'get_my_content',
  'check_illustration_status',
  'list_si_agents',
  'get_si_session_status',
  'list_committee_co_leaders',
  'find_duplicate_orgs',
  'send_invoice',
  'confirm_send_invoice',
].map(tool).concat(
  CANONICAL_MEETING_TOOLS,
  CANONICAL_COMMUNITY_GROUP_TOOLS,
  CANONICAL_ADMIN_MEMBER_RECORDS_TOOLS,
  CANONICAL_ADMIN_BRAND_LOGO_TOOLS,
  CANONICAL_ADMIN_BILLING_TOOLS,
  CANONICAL_ADMIN_PROSPECT_TOOLS,
  CANONICAL_ADMIN_FEED_TOOLS,
  CANONICAL_ADMIN_WORKFLOW_TOOLS,
  CANONICAL_ADCP_AGENT_MANAGEMENT_TOOLS,
  CANONICAL_OUTREACH_REPORTING_TOOLS,
  CANONICAL_BRAND_IDENTITY_TOOLS,
  CANONICAL_AGENT_PUBLISHER_DIRECTORY_TOOLS,
  CANONICAL_PROPERTY_IDENTIFIER_CATALOG_TOOLS,
);

function stage(provider: ModelProvider, maxIterations: number): FixedTraceProviderStageConfig {
  return {
    provider,
    model: 'claude-haiku-4-5',
    reasoningEffort: 'none',
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations,
    transportRetries: 0,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing: {
      profileId: 'anthropic-standard-2026-08:claude-haiku-4-5',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      cacheReadUsdPerMillionTokens: 0.1,
      cacheWriteUsdPerMillionTokens: 1.25,
      cacheReadAccounting: 'additive',
      cacheWriteAccounting: 'additive',
      source: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
    },
  };
}

function config(
  router: ModelProvider,
  generation: ModelProvider,
  overrides: Partial<FixedTraceRunnerConfig> = {},
): FixedTraceRunnerConfig {
  const traceSuite = overrides.traceSuite ?? FIXED_TRACE_SUITE;
  const fixtureNames = new Set(traceSuite.flatMap((trace) => trace.toolFixtures.map((fixture) => fixture.name)));
  const base = {
    runId: 'fixed-run-test',
    sourceBundleSha256: HASH,
    gitCommit: 'abcdef0',
    gitDirty: false,
    promptConfigVersion: 'synthetic-prompt-v1',
    traceSuite,
    traceSuiteSha256: fixedTraceSuiteSha256(traceSuite),
    toolDefinitions: overrides.toolDefinitions ?? TOOL_DEFINITIONS.filter((definition) => fixtureNames.has(definition.name)),
    router: stage(router, 1),
    generation: stage(generation, 3),
    ...overrides,
  };
  return {
    ...base,
    traceSuiteSha256: overrides.traceSuiteSha256 ?? fixedTraceSuiteSha256(base.traceSuite),
  };
}

function trace(id: string): FixedTraceCase {
  const selected = FIXED_TRACE_SUITE.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`Missing trace ${id}`);
  return selected;
}

function expandedFixtureTrace(id = 'expanded-fixture-tool'): FixedTraceCase {
  const expanded = structuredClone(trace('provider-unavailable'));
  return {
    ...expanded,
    id,
    toolFixtures: [{
      name: 'expanded_fixture_tool',
      effect: 'read',
      resultStatus: 'ok',
      result: 'Synthetic expanded-suite fixture result.',
    }],
  };
}

describe('fixed trace artifact runner', () => {
  it('fails closed architecture comparison while candidate-visible tools are fixture-local', () => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    expect(() => assertFixedTraceArchitectureComparisonPrerequisite(config(router, generation))).toThrow(
      'common authenticated base registry/schema/receipt tool universe is unavailable',
    );
    expect(router.respondCalls).toHaveLength(0);
    expect(generation.respondCalls).toHaveLength(0);
  });
  it('uses production quick-match terminal behavior only from allowed request facts', () => {
    const selectedTrace = trace('knowledge-task-model');
    const policy = fixedTraceHybridPolicy();
    const decide = (candidate: FixedTraceCase) => decideFixedTraceHybridRoute({
      message: candidate.request.message,
      source: candidate.request.source,
      isAdmin: candidate.request.isAdmin,
      isThread: (candidate.request.threadContext?.length ?? 0) > 0,
      channelPrivacy: candidate.request.channelPrivacy,
      policy,
    });
    const obvious: FixedTraceCase = {
      ...selectedTrace,
      request: { source: 'dm', message: 'ok', isAdmin: false, nowUtc: selectedTrace.request.nowUtc },
    };
    const answerLeakingChanges: FixedTraceCase = {
      ...obvious,
      routing: { action: 'respond', toolSets: ['admin_events'] },
      toolFixtures: [{ name: 'fixture_only', effect: 'mutation', resultStatus: 'ok', result: 'different fixture result' }],
      expectation: {
        ...obvious.expectation,
        requiredTools: ['fixture_only'],
        allowedTools: ['fixture_only'],
        requiredTextAny: [['different expected answer']],
      },
      answerRubric: ['different grade label'],
    };

    // `quickMatchRoutingContext` intentionally reports measured local latency.
    // The routing decision must remain fixture-independent, but wall-clock
    // timing is not part of that stable decision contract.
    const withoutLatency = (decision: ReturnType<typeof decideFixedTraceHybridRoute>) => ({
      ...decision,
      plan: decision.plan === null
        ? null
        : (({ latency_ms: _latencyMs, ...plan }) => plan)(decision.plan),
    });
    expect(withoutLatency(decide(answerLeakingChanges))).toEqual(withoutLatency(decide(obvious)));
    expect(decide(obvious)).toMatchObject({
      mode: 'local_terminal', reason: 'production_quick_match_terminal', plan: { action: 'ignore' },
    });
  });

  it('runs obvious local outcomes without a router dispatch and routes ambiguous cases through the incumbent stages', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const localTrace: FixedTraceCase = {
      ...selectedTrace,
      request: { source: 'dm', message: 'ok', isAdmin: false, nowUtc: selectedTrace.request.nowUtc },
    };
    const localRouter = new ScriptedProvider([]);
    const localGeneration = new ScriptedProvider([]);
    const local = await runFixedTraceCase(localTrace, config(localRouter, localGeneration, {
      traceSuite: [localTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));
    expect(local).toMatchObject({ terminalStage: 'surface', terminalStatus: 'ignored', route: { action: 'ignore', toolSets: [] } });
    expect(local.metadata.hybridPolicy).toEqual(fixedTraceHybridPolicy());
    expect(localRouter.respondCalls).toHaveLength(0);
    expect(localGeneration.respondCalls).toHaveLength(0);

    const ambiguousTrace: FixedTraceCase = {
      ...selectedTrace,
      request: { source: 'dm', message: 'Explain AdCP authentication.', isAdmin: false, nowUtc: selectedTrace.request.nowUtc },
    };
    const ambiguousRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const ambiguousGeneration = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    const ambiguous = await runFixedTraceCase(ambiguousTrace, config(ambiguousRouter, ambiguousGeneration, {
      traceSuite: [ambiguousTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));
    expect(ambiguous.terminalStage).toBe('generation');
    expect(ambiguousRouter.respondCalls).toHaveLength(1);
    expect(ambiguousGeneration.respondCalls).toHaveLength(1);
  });

  it('fails hybrid admission safe for tool-bearing, admin, thread, and unknown-privacy cases', () => {
    const policy = fixedTraceHybridPolicy();
    const decide = (input: Parameters<typeof decideFixedTraceHybridRoute>[0]) => decideFixedTraceHybridRoute({ ...input, policy });
    expect(decide({ message: 'attendee list for the summit', source: 'dm', isAdmin: false, isThread: false }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'unsafe_or_ambiguous_message' });
    expect(decide({ message: 'send the invoice to the member', source: 'dm', isAdmin: false, isThread: false }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'unsafe_or_ambiguous_message' });
    expect(decide({ message: 'thanks', source: 'dm', isAdmin: true, isThread: false }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'admin_requires_router' });
    expect(decide({ message: 'thanks', source: 'dm', isAdmin: false, isThread: true }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'thread_context_requires_router' });
    expect(decide({ message: 'hello', source: 'channel', isAdmin: false, isThread: false, channelPrivacy: 'public' }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'channel_privacy_not_captured' });
    expect(decide({ message: 'hello', source: 'channel', isAdmin: false, isThread: false }))
      .toMatchObject({ mode: 'llm_router_fallback', reason: 'channel_privacy_not_captured' });
  });

  it('fails closed for exact and adjacent mutation, tool, delimiter, negation, and control-byte bypasses', () => {
    const policy = fixedTraceHybridPolicy();
    const decide = (message: string) => decideFixedTraceHybridRoute({
      message, source: 'channel', isAdmin: false, isThread: false, channelPrivacy: 'private', policy,
    });
    for (const message of [
      'ship invoice now',
      'delete it thanks',
      'hi; delete user',
      'not hi delete it',
      'hi\u2028delete user',
      'hi\0delete user',
    ]) {
      expect(decide(message)).toMatchObject({ mode: 'llm_router_fallback', reason: 'unsafe_or_ambiguous_message' });
    }
    expect(decide('hi')).toMatchObject({ mode: 'local_terminal', plan: { action: 'react', emoji: 'wave' } });
    expect(decide('thanks')).toMatchObject({ mode: 'local_terminal', plan: { action: 'react', emoji: 'heart' } });
  });

  it('snapshots request facts before matching, catches matcher failures, and never dispatches an unsafe local request', async () => {
    const policy = fixedTraceHybridPolicy();
    const throwingMatcher = decideFixedTraceHybridRoute({
      message: 'ok', source: 'dm', isAdmin: false, isThread: false, policy,
      quickMatcher: () => { throw new Error('matcher failure'); },
    });
    expect(throwingMatcher).toMatchObject({ mode: 'llm_router_fallback', reason: 'quick_match_exception', plan: null });

    const mutableInput = {
      message: 'ok', source: 'dm' as const, isAdmin: false, isThread: false, policy,
      quickMatcher: (snapshot: Readonly<{ message: string; source: 'dm' | 'channel'; isThread: boolean; isAAOAdmin: boolean }>) => {
        mutableInput.message = 'delete user';
        expect(snapshot).toEqual({ message: 'ok', source: 'dm', isThread: false, isAAOAdmin: false });
        expect(Object.isFrozen(snapshot)).toBe(true);
        return { action: 'ignore' as const, reason: 'synthetic', decision_method: 'quick_match' as const };
      },
    };
    expect(decideFixedTraceHybridRoute(mutableInput)).toMatchObject({ mode: 'local_terminal', plan: { action: 'ignore' } });

    const getterInput = Object.defineProperties({}, {
      message: { get: () => { throw new Error('untrusted getter'); }, enumerable: true },
      source: { value: 'dm', enumerable: true },
      isAdmin: { value: false, enumerable: true },
      isThread: { value: false, enumerable: true },
      policy: { value: policy, enumerable: true },
    });
    expect(() => decideFixedTraceHybridRoute(getterInput as Parameters<typeof decideFixedTraceHybridRoute>[0]))
      .toThrow(FixedTraceHybridAdmissionSnapshotError);
    const proxyInput = new Proxy({ message: 'ok', source: 'dm', isAdmin: false, isThread: false, policy }, {
      getOwnPropertyDescriptor: () => { throw new Error('untrusted proxy'); },
    });
    expect(() => decideFixedTraceHybridRoute(proxyInput as Parameters<typeof decideFixedTraceHybridRoute>[0]))
      .toThrow(FixedTraceHybridAdmissionSnapshotError);

    const selectedTrace = trace('knowledge-task-model');
    const unsafeTrace: FixedTraceCase = {
      ...selectedTrace,
      request: { source: 'dm', message: 'hi delete it', isAdmin: false, nowUtc: selectedTrace.request.nowUtc },
    };
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    await runFixedTraceCase(unsafeTrace, config(router, generation, {
      traceSuite: [unsafeTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));
    expect(router.respondCalls).toHaveLength(1);
    expect(generation.respondCalls).toHaveLength(1);
  });

  it('marks legacy hybrid replay as uncovered and exercises reviewed local admission only with the separate evaluator suite', async () => {
    const policy = fixedTraceHybridPolicy();
    const canonicalDecisions = FIXED_TRACE_SUITE.map((candidate) => decideFixedTraceHybridRoute({
      message: candidate.request.message,
      source: candidate.request.source,
      isAdmin: candidate.request.isAdmin,
      isThread: (candidate.request.threadContext?.length ?? 0) > 0,
      channelPrivacy: candidate.request.channelPrivacy,
      policy,
    }));
    expect(canonicalDecisions).toHaveLength(32);
    expect(canonicalDecisions.every((decision) => decision.mode === 'llm_router_fallback')).toBe(true);

    const legacyTrace = trace('knowledge-task-model');
    const legacyRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const legacyGeneration = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    const legacyObservations = await runFixedTraceSuite(config(legacyRouter, legacyGeneration, {
      traceSuite: [legacyTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));
    expect(summarizeFixedTraceRun(legacyObservations, [legacyTrace]).summary.hybridCoverage).toMatchObject({
      plannerBound: false, localAdmissionCount: 0, sufficient: false, blocker: 'hybrid_evaluator_suite_not_bound',
    });

    const localObservations = await runFixedTraceSuite(config(new ScriptedProvider([]), new ScriptedProvider([]), {
      traceSuite: FIXED_TRACE_HYBRID_EVALUATOR_SUITE,
      architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));
    const coverage = summarizeFixedTraceRun(localObservations, FIXED_TRACE_HYBRID_EVALUATOR_SUITE).summary.hybridCoverage;
    expect(coverage).toMatchObject({
      plannerBound: true,
      localAdmissionCount: FIXED_TRACE_HYBRID_MINIMUM_LOCAL_ADMISSIONS,
      sufficient: true,
      blocker: null,
    });

    // A local terminal result whose router metadata is not `not_run` is not
    // admissible local-coverage evidence. This keeps the evidence gate
    // fail-closed even when a serialized observation is internally invalid.
    const zeroLocalCoverage = localObservations.map((observation) => ({
      ...observation,
      metadata: {
        ...observation.metadata,
        router: { ...observation.metadata.router, source: 'local' as const },
      },
    }));
    expect(summarizeFixedTraceRun(zeroLocalCoverage, FIXED_TRACE_HYBRID_EVALUATOR_SUITE).summary.hybridCoverage)
      .toMatchObject({
        plannerBound: true,
        localAdmissionCount: 0,
        sufficient: false,
        blocker: 'hybrid_local_admission_coverage_below_minimum',
      });
  });

  it('keeps routed tool definitions and generation execution identical after hybrid fallback', async () => {
    const selectedTrace: FixedTraceCase = {
      ...trace('knowledge-task-model'),
      request: {
        ...trace('knowledge-task-model').request,
        threadContext: [{ user: 'member', text: 'Please continue with the protocol explanation.' }],
      },
    };
    const incumbentRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const incumbentGeneration = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    await runFixedTraceCase(selectedTrace, config(incumbentRouter, incumbentGeneration, { traceSuite: [selectedTrace] }));

    const hybridRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const hybridGeneration = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    await runFixedTraceCase(selectedTrace, config(hybridRouter, hybridGeneration, {
      traceSuite: [selectedTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }));

    expect(hybridRouter.respondCalls).toHaveLength(1);
    expect(hybridRouter.respondCalls).toEqual(incumbentRouter.respondCalls);
    expect(hybridGeneration.respondCalls).toEqual(incumbentGeneration.respondCalls);
  });

  it('binds hybrid policy and fallback-router controls into the frozen architecture identity', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const policy = fixedTraceHybridPolicy();
    const hybrid = config(new ScriptedProvider([]), new ScriptedProvider([]), {
      traceSuite: [selectedTrace], architectureArm: 'deterministic_policy_llm_fallback_hybrid', hybridPolicy: policy,
    });
    const incumbent = { ...hybrid, architectureArm: 'two_stage_llm_router' as const, hybridPolicy: undefined };
    expect(fixedTraceArchitectureConfigSha256(hybrid)).not.toBe(fixedTraceArchitectureConfigSha256(incumbent));
    expect(fixedTraceArchitectureConfigSha256({ ...hybrid, hybridPolicy: { ...policy, version: 'fixed-trace-hybrid-quick-match-v2' } }))
      .not.toBe(fixedTraceArchitectureConfigSha256(hybrid));
    expect(fixedTraceArchitectureConfigSha256({ ...hybrid, hybridPolicy: { ...policy, localTerminalActions: ['ignore'] } }))
      .not.toBe(fixedTraceArchitectureConfigSha256(hybrid));
    expect(fixedTraceArchitectureConfigSha256({ ...hybrid, router: { ...hybrid.router, timeoutMs: 20_000 } }))
      .not.toBe(fixedTraceArchitectureConfigSha256(hybrid));

    const invalidRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(selectedTrace, config(invalidRouter, new ScriptedProvider([]), {
      traceSuite: [selectedTrace],
      architectureArm: 'deterministic_policy_llm_fallback_hybrid',
      hybridPolicy: { ...policy, localTerminalActions: ['respond' as never] },
    }))).rejects.toThrow('Fixed trace hybrid policy is invalid');
    expect(invalidRouter.respondCalls).toHaveLength(0);
  });

  it('does not permit hybrid policy restamping after the first dispatch', async () => {
    const firstTrace = trace('knowledge-task-model');
    const secondTrace = { ...structuredClone(firstTrace), id: 'hybrid-second-trace' };
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]);
    const runConfig = config(router, generation, {
      traceSuite: [firstTrace, secondTrace],
      architectureArm: 'deterministic_policy_llm_fallback_hybrid',
      hybridPolicy: { ...fixedTraceHybridPolicy() },
    });
    await runFixedTraceCase(firstTrace, runConfig);
    runConfig.hybridPolicy!.version = 'fixed-trace-hybrid-quick-match-v2';
    await expect(runFixedTraceCase(secondTrace, runConfig))
      .rejects.toThrow('Fixed trace runner execution identity changed after dispatch binding');
    expect(router.respondCalls).toHaveLength(1);
    expect(generation.respondCalls).toHaveLength(1);
  });
  it('keeps an unapproved same-provider returned model unpriced for failure telemetry', async () => {
    const router = new ScriptedProvider([{ ...routeResponse('respond', ['knowledge']), model: 'other-anthropic-model' }]);
    const generation = new ScriptedProvider([
      response([{ type: 'text', text: 'Synthetic protocol explanation.' }]),
    ]);
    const observation = await runFixedTraceCase(trace('knowledge-task-model'), config(router, generation));

    expect(observation.metadata.router).toMatchObject({
      returnedProvider: 'anthropic',
      returnedModel: 'other-anthropic-model',
      modelResolution: 'provider_canonicalized',
      estimatedCostUsd: null,
      pricingSource: null,
      pricingProfileId: null,
    });
    expect(gradeFixedTrace(trace('knowledge-task-model'), observation).failures)
      .toEqual(expect.arrayContaining(['router_model_resolution_policy_mismatch', 'router_cost_provenance_missing']));
  });

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

  it('replays community discussion search without exposing industry research', async () => {
    const selectedTrace = trace('community-discussion-search-read-only');
    const router = new ScriptedProvider([routeResponse('respond', ['community_discussions'])]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call',
        id: 'community-tool-1',
        name: 'search_slack',
        input: { query: 'synthetic community meetup formats' },
      }], 'tool_calls', 'community-search'),
      response([{
        type: 'text',
        text: 'Members preferred small working sessions with a published recap.',
      }], 'stop', 'community-final'),
    ]);

    const observation = await runFixedTraceCase(selectedTrace, config(router, generation));

    expect(observation.route).toEqual({ action: 'respond', toolSets: ['community_discussions'] });
    expect(observation.tools.map((tool) => tool.name)).toEqual(['search_slack']);
    expect(generation.respondCalls[0].tools?.map((tool) => tool.name)).toEqual(['search_slack']);
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({ deterministicPass: true });
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
      rejectedToolCalls: [{ name: 'create_working_group_post', reason: 'duplicate_tool_call' }],
      tools: [
        {
          name: 'list_working_groups',
          resultStatus: 'ok',
          simulated: true,
        },
        {
          name: 'create_working_group_post',
          resultStatus: 'ok',
          simulated: true,
        },
      ],
    });
    expect(observation.metadata.generation).toMatchObject({
      source: 'local',
      usageKnown: true,
      usage: { inputTokens: 30, outputTokens: 15 },
      estimatedCostUsd: 0.000105,
      pricingSource: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
    });
    expect(gradeFixedTrace(selectedTrace, observation)).toMatchObject({
      deterministicPass: false,
      toolSelectionPass: false,
      // The duplicate mutation was rejected before execution, so the
      // selection failure must not be misreported as an executed mutation.
      mutationSafetyPass: true,
      failures: expect.arrayContaining(['tool_selection_mismatch']),
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
      profileId: 'anthropic-standard-2026-08:claude-haiku-4-5',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      cacheReadUsdPerMillionTokens: 0.1,
      cacheWriteUsdPerMillionTokens: 1.25,
      cacheReadAccounting: 'additive',
      cacheWriteAccounting: 'additive',
      source: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
    }, fixedTraceResponsePricingPolicy('anthropic', 'claude-haiku-4-5', stage(delegate, 1).pricing));
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

  it('keeps exact usage for a dispatched malformed tool turn', async () => {
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
      rejectedToolCalls: [{ name: 'unknown_tool', reason: 'unknown_tool_call' }],
      metadata: {
        generation: {
          source: 'local',
          dispatched: true,
          usageKnown: true,
          usage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.000035,
          pricingSource: 'Repository Anthropic pricing table: Claude Haiku 4.5, refreshed August 2026.',
        },
      },
    });
    expect(observation.metadata.generation.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes exactly the canonical fixed-trace tool subset', () => {
    expect(fixedTraceToolSchemaSha256(FIXED_TRACE_SUITE, TOOL_DEFINITIONS)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => fixedTraceToolSchemaSha256(FIXED_TRACE_SUITE, TOOL_DEFINITIONS.slice(1)))
      .toThrow('incomplete or duplicated');
  });

  it('rejects unused fixture-local definitions for routed, hybrid, and oracle execution', async () => {
    const selectedTrace = trace('knowledge-task-model');
    for (const architectureArm of ['two_stage_llm_router', 'deterministic_policy_llm_fallback_hybrid', 'oracle_route_diagnostic'] as const) {
      const router = new ScriptedProvider([]);
      await expect(runFixedTraceCase(selectedTrace, config(router, new ScriptedProvider([]), {
        architectureArm,
        toolDefinitions: [...TOOL_DEFINITIONS, tool('out_of_suite_fixture_tool')],
      }))).rejects.toThrow('routed/hybrid/oracle definitions must exactly match configured suite fixtures');
      expect(router.respondCalls).toHaveLength(0);
    }
  });

  it('binds expanded-suite fixture schemas to execution and cohort identity', async () => {
    const firstTrace = expandedFixtureTrace();
    const secondTrace = expandedFixtureTrace('expanded-fixture-tool-second');
    const expandedSuite = [firstTrace, secondTrace];
    const fixtureDefinition = tool('expanded_fixture_tool');
    const definitions = [fixtureDefinition];
    const expandedSchemaSha256 = fixedTraceToolSchemaSha256(expandedSuite, definitions);
    const staleSchemaSha256 = HASH;
    expect(expandedSchemaSha256).not.toBe(staleSchemaSha256);

    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const expandedConfig = config(router, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: definitions,
    });
    const first = await runFixedTraceCase(firstTrace, expandedConfig, expandedSchemaSha256);
    expect(first.metadata.toolSchemaSha256).toBe(expandedSchemaSha256);
    expect(() => summarizeFixedTraceRun([first], expandedSuite)).not.toThrow();

    const changedFixtureDefinition: AddieTool = {
      ...fixtureDefinition,
      input_schema: {
        ...fixtureDefinition.input_schema,
        properties: { ...fixtureDefinition.input_schema.properties, expanded_filter: { type: 'string' } },
      },
    };
    const changedDefinitions = definitions.map((definition) => (
      definition.name === changedFixtureDefinition.name ? changedFixtureDefinition : definition
    ));
    const changedSchemaSha256 = fixedTraceToolSchemaSha256(expandedSuite, changedDefinitions);
    expect(changedSchemaSha256).not.toBe(expandedSchemaSha256);
    expect(fixedTraceArchitectureConfigSha256({ ...expandedConfig, toolDefinitions: changedDefinitions }))
      .not.toBe(fixedTraceArchitectureConfigSha256(expandedConfig));

    const missingRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(firstTrace, config(missingRouter, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: TOOL_DEFINITIONS,
    }))).rejects.toThrow('routed/hybrid/oracle definitions must exactly match configured suite fixtures');
    expect(missingRouter.respondCalls).toHaveLength(0);

    const duplicateRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(firstTrace, config(duplicateRouter, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: [...definitions, fixtureDefinition],
    }))).rejects.toThrow('routed/hybrid/oracle definitions must exactly match configured suite fixtures');
    expect(duplicateRouter.respondCalls).toHaveLength(0);

    const staleRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(firstTrace, config(staleRouter, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: definitions,
    }), staleSchemaSha256)).rejects.toThrow('supplied tool schema hash does not match');
    expect(staleRouter.respondCalls).toHaveLength(0);

    const restamped = structuredClone(first);
    restamped.metadata.toolSchemaSha256 = staleSchemaSha256;
    expect(() => summarizeFixedTraceRun([restamped], expandedSuite))
      .toThrow('Fixed trace architecture contract fingerprint mismatch');

    const mixedRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const changed = await runFixedTraceCase(secondTrace, config(mixedRouter, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: changedDefinitions,
    }));
    expect(() => summarizeFixedTraceRun([first, changed], expandedSuite))
      .toThrow('Mixed fixed trace run metadata');

    const boundDefinitions = [...definitions];
    const boundRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const bound = config(boundRouter, new ScriptedProvider([]), {
      traceSuite: expandedSuite,
      toolDefinitions: boundDefinitions,
    });
    await runFixedTraceCase(firstTrace, bound);
    (bound as { toolDefinitions: ReadonlyArray<AddieTool> }).toolDefinitions = changedDefinitions;
    await expect(runFixedTraceCase(secondTrace, bound))
      .rejects.toThrow('Fixed trace runner execution identity changed after dispatch binding');
    expect(boundRouter.respondCalls).toHaveLength(1);
  });

  it('revalidates the immutable execution identity at each provider dispatch edge', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const deferredRouter = new DeferredBeforeDispatchProvider([routeResponse('respond', ['knowledge'])]);
    const runConfig = config(deferredRouter, new ScriptedProvider([]));
    const pending = runFixedTraceCase(selectedTrace, runConfig);
    await deferredRouter.beforeDispatchPending;

    const changedSearchDocs = tool('search_docs');
    changedSearchDocs.input_schema.properties = {
      ...changedSearchDocs.input_schema.properties,
      forged_during_dispatch: { type: 'string' },
    };
    (runConfig as { toolDefinitions: ReadonlyArray<AddieTool> }).toolDefinitions = TOOL_DEFINITIONS.map((definition) => (
      definition.name === changedSearchDocs.name ? changedSearchDocs : definition
    ));
    deferredRouter.release();

    await expect(pending).rejects.toThrow('Fixed trace runner execution identity changed before provider dispatch');
    expect(deferredRouter.respondCalls).toHaveLength(0);

    const generationRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const deferredGeneration = new DeferredBeforeDispatchProvider([response([
      { type: 'text', text: 'Synthetic protocol explanation.' },
    ])]);
    const generationConfig = config(generationRouter, deferredGeneration);
    const generationPending = runFixedTraceCase(selectedTrace, generationConfig);
    await deferredGeneration.beforeDispatchPending;
    (generationConfig as { traceSuiteSha256: string }).traceSuiteSha256 = HASH;
    deferredGeneration.release();

    await expect(generationPending)
      .rejects.toThrow('Fixed trace runner execution identity became invalid before provider dispatch');
    expect(generationRouter.respondCalls).toHaveLength(1);
    expect(deferredGeneration.respondCalls).toHaveLength(0);
  });

  it('revalidates evaluator-owned run provenance before provider dispatch and between cases', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const replacement = createHash('sha256').update('replacement-provenance').digest('hex');
    const mutations: Array<(runConfig: FixedTraceRunnerConfig) => void> = [
      (runConfig) => { runConfig.runId = 'forged-run-id'; },
      (runConfig) => { runConfig.sourceBundleSha256 = replacement; },
      (runConfig) => { runConfig.repetition = 2; },
    ];
    for (const mutate of mutations) {
      const router = new DeferredBeforeDispatchProvider([routeResponse('respond', ['knowledge'])]);
      const runConfig = config(router, new ScriptedProvider([]));
      const pending = runFixedTraceCase(selectedTrace, runConfig);
      await router.beforeDispatchPending;
      mutate(runConfig);
      router.release();
      await expect(pending).rejects.toThrow('Fixed trace runner execution identity changed before provider dispatch');
      expect(router.respondCalls).toHaveLength(0);
    }

    const firstTrace = expandedFixtureTrace();
    const secondTrace = expandedFixtureTrace('expanded-provenance-second');
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const runConfig = config(router, new ScriptedProvider([]), {
      traceSuite: [firstTrace, secondTrace],
      toolDefinitions: [tool('expanded_fixture_tool')],
    });
    await runFixedTraceCase(firstTrace, runConfig);
    runConfig.runId = 'mutated-between-cases';
    await expect(runFixedTraceCase(secondTrace, runConfig))
      .rejects.toThrow('Fixed trace runner execution identity changed after dispatch binding');
    expect(router.respondCalls).toHaveLength(1);
  });

  it.each([
    ['blank run ID', (runConfig: FixedTraceRunnerConfig) => { runConfig.runId = '   '; }],
    ['blank prompt config version', (runConfig: FixedTraceRunnerConfig) => { runConfig.promptConfigVersion = ' '; }],
    ['malformed source bundle hash', (runConfig: FixedTraceRunnerConfig) => { runConfig.sourceBundleSha256 = 'not-a-hash'; }],
    ['malformed git commit', (runConfig: FixedTraceRunnerConfig) => { runConfig.gitCommit = 'BAD!'; }],
    ['non-boolean dirty flag', (runConfig: FixedTraceRunnerConfig) => { (runConfig as unknown as { gitDirty: unknown }).gitDirty = 'yes'; }],
    ['invalid repetition', (runConfig: FixedTraceRunnerConfig) => { runConfig.repetition = 0; }],
    ['invalid definition provenance', (runConfig: FixedTraceRunnerConfig) => {
      (runConfig as unknown as { toolDefinitionProvenance: unknown }).toolDefinitionProvenance = 'forged';
    }],
    ['non-boolean degradation injection', (runConfig: FixedTraceRunnerConfig) => {
      (runConfig as unknown as { injectProviderDegradation: unknown }).injectProviderDegradation = 1;
    }],
  ])('rejects %s run provenance before any provider dispatch', async (_name, mutate) => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    const runConfig = config(router, generation);
    mutate(runConfig);

    await expect(runFixedTraceCase(trace('knowledge-task-model'), runConfig))
      .rejects.toThrow('Fixed trace runner');
    expect(router.respondCalls).toHaveLength(0);
    expect(generation.respondCalls).toHaveLength(0);
  });

  it('revalidates execution identity before a tool-loop continuation dispatch', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new DeferredContinuationProvider([
      response([{
        type: 'tool_call', id: 'expanded-continuation-tool', name: 'search_docs', input: { query: 'task model' },
      }], 'tool_calls'),
      response([{ type: 'text', text: 'Synthetic protocol explanation.' }]),
    ]);
    const runConfig = config(router, generation);
    const pending = runFixedTraceCase(selectedTrace, runConfig);
    await generation.beforeContinuationPending;
    (runConfig as { traceSuiteSha256: string }).traceSuiteSha256 = HASH;
    generation.release();

    await expect(pending)
      .rejects.toThrow('Fixed trace runner execution identity became invalid before provider dispatch');
    expect(router.respondCalls).toHaveLength(1);
    expect(generation.respondCalls).toHaveLength(1);
  });

  it('rejects a suite truncated after a completed case instead of silently omitting its tail', async () => {
    const first = trace('knowledge-task-model');
    const second = trace('community-discussion-search-read-only');
    let runConfig!: FixedTraceRunnerConfig;
    const router = new MutatingResponseProvider([
      routeResponse('ignore'),
    ], () => {
      (runConfig.traceSuite as FixedTraceCase[]).splice(1);
    });
    runConfig = config(router, new ScriptedProvider([]), { traceSuite: [first, second] });

    await expect(runFixedTraceSuite(runConfig))
      .rejects.toThrow('Fixed trace runner execution identity became invalid before provider dispatch');
    expect(router.respondCalls).toHaveLength(1);
  });

  it('does not construct a manual diagnostic candidate summary after final-response identity mutation', async () => {
    const selectedTrace = trace('knowledge-task-model');
    let runConfig!: FixedTraceRunnerConfig;
    const router = new MutatingResponseProvider([routeResponse('ignore')], () => {
      runConfig.runId = 'mutated-after-final-response';
    });
    runConfig = config(router, new ScriptedProvider([]), { traceSuite: [selectedTrace] });

    await expect(runFixedTraceDiagnosticCandidate(runConfig))
      .rejects.toThrow('Fixed trace runner execution identity changed before provider dispatch');
    expect(router.respondCalls).toHaveLength(1);
  });

  it('preflights duplicate fixture registration and invalid executable schemas before router dispatch', async () => {
    const expandedTrace = expandedFixtureTrace('expanded-invalid-schema');
    const invalidDefinition = structuredClone(tool('expanded_fixture_tool'));
    invalidDefinition.input_schema = {
      type: 'object',
      properties: { impossible: { type: 'not-a-json-schema-type' } },
    };
    const invalidSchemaRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(expandedTrace, config(invalidSchemaRouter, new ScriptedProvider([]), {
      traceSuite: [expandedTrace],
      toolDefinitions: [invalidDefinition],
    }))).rejects.toMatchObject({ reason: 'tool_schema_invalid' });
    expect(invalidSchemaRouter.respondCalls).toHaveLength(0);

    const hybridInvalidSchemaRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(expandedTrace, config(hybridInvalidSchemaRouter, new ScriptedProvider([]), {
      traceSuite: [expandedTrace],
      toolDefinitions: [invalidDefinition],
      architectureArm: 'deterministic_policy_llm_fallback_hybrid',
    }))).rejects.toMatchObject({ reason: 'tool_schema_invalid' });
    expect(hybridInvalidSchemaRouter.respondCalls).toHaveLength(0);

    const duplicateFixtureTrace = structuredClone(trace('knowledge-task-model'));
    duplicateFixtureTrace.toolFixtures = [
      ...duplicateFixtureTrace.toolFixtures,
      structuredClone(duplicateFixtureTrace.toolFixtures[0]),
    ];
    const duplicateFixtureRouter = new ScriptedProvider([]);
    await expect(runFixedTraceCase(duplicateFixtureTrace, config(duplicateFixtureRouter, new ScriptedProvider([]), {
      traceSuite: [duplicateFixtureTrace],
      toolDefinitions: TOOL_DEFINITIONS.filter((definition) => duplicateFixtureTrace.toolFixtures.some(
        (fixture) => fixture.name === definition.name,
      )),
    }))).rejects.toMatchObject({ reason: 'fixture_definition_mismatch' });
    expect(duplicateFixtureRouter.respondCalls).toHaveLength(0);
  });

  it('preflights fixture schemas once per complete identity, not per provider dispatch', async () => {
    const expandedTrace = expandedFixtureTrace('preflight-compilation-count');
    expandedTrace.category = 'knowledge';
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call', id: 'preflight-tool', name: 'expanded_fixture_tool', input: { query: 'fixture' },
      }], 'tool_calls'),
      response([{ type: 'text', text: 'Synthetic fixture response.' }]),
    ]);
    const compile = vi.spyOn(Ajv.prototype, 'compile');

    await runFixedTraceSuite(config(router, generation, {
      traceSuite: [expandedTrace],
      toolDefinitions: [tool('expanded_fixture_tool')],
    }));

    // One compilation at runner preflight and one at actual loop registration.
    // Router plus two generation dispatches must not multiply this work.
    expect(compile).toHaveBeenCalledTimes(2);
    expect(router.respondCalls).toHaveLength(1);
    expect(generation.respondCalls).toHaveLength(2);
    compile.mockRestore();
  });

  it('aborts deterministic provider preparation rather than scoring it as provider evidence', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const routerPreparationFailure = new ScriptedProvider([]);
    routerPreparationFailure.prepare.mockImplementation(() => {
      throw new UnsupportedModelCapabilityError('anthropic', 'reasoning');
    });
    const unusedGeneration = new ScriptedProvider([]);

    await expect(runFixedTraceCase(selectedTrace, config(routerPreparationFailure, unusedGeneration)))
      .rejects.toThrow('Fixed trace router request preparation failed');
    expect(routerPreparationFailure.respondCalls).toHaveLength(0);
    expect(unusedGeneration.respondCalls).toHaveLength(0);

    const routed = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generationPreparationFailure = new ScriptedProvider([]);
    generationPreparationFailure.prepare.mockImplementation(() => {
      throw new Error('synthetic invalid generation request');
    });

    await expect(runFixedTraceCase(selectedTrace, config(routed, generationPreparationFailure)))
      .rejects.toThrow('Fixed trace generation request preparation failed');
    expect(routed.respondCalls).toHaveLength(1);
    expect(generationPreparationFailure.respondCalls).toHaveLength(0);
  });

  it('aborts a deterministic continuation preparation failure before a second generation dispatch', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([response([{
      type: 'tool_call', id: 'continuation-preparation-tool', name: 'search_docs', input: { query: 'task model' },
    }], 'tool_calls')]);
    let preparations = 0;
    generation.prepare.mockImplementation((request) => {
      preparations += 1;
      // First turn is preflighted then prepared by `respond`; the third
      // preparation is the post-tool continuation and must abort locally.
      if (preparations === 3) throw new Error('synthetic continuation request is invalid');
      return {
        provider: generation.id,
        model: request.model,
        capabilities: generation.capabilities,
        requestMetadata: request.requestMetadata,
        providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
      } satisfies PreparedModelInvocation;
    });

    await expect(runFixedTraceCase(selectedTrace, config(router, generation)))
      .rejects.toThrow('Fixed trace generation request preparation failed');
    expect(router.respondCalls).toHaveLength(1);
    expect(generation.respondCalls).toHaveLength(1);
    expect(preparations).toBe(3);
  });

  it('rejects empty or duplicate-ID evaluator suites before provider dispatch', async () => {
    const selectedTrace = trace('knowledge-task-model');
    const duplicate = structuredClone(selectedTrace);
    const emptyRouter = new ScriptedProvider([]);
    await expect(runFixedTraceSuite(config(emptyRouter, new ScriptedProvider([]), {
      traceSuite: [],
    }))).rejects.toThrow('empty, blank, duplicated');
    expect(emptyRouter.respondCalls).toHaveLength(0);

    const duplicateRouter = new ScriptedProvider([]);
    await expect(runFixedTraceSuite(config(duplicateRouter, new ScriptedProvider([]), {
      traceSuite: [selectedTrace, duplicate],
    }))).rejects.toThrow('empty, blank, duplicated');
    expect(duplicateRouter.respondCalls).toHaveLength(0);

    for (const invalidId of ['', '   ', 123 as unknown as string]) {
      const invalid = structuredClone(selectedTrace) as FixedTraceCase;
      (invalid as { id: string }).id = invalidId;
      const invalidRouter = new ScriptedProvider([]);
      await expect(runFixedTraceSuite(config(invalidRouter, new ScriptedProvider([]), {
        traceSuite: [invalid],
      }))).rejects.toThrow('empty, blank, duplicated');
      expect(invalidRouter.respondCalls).toHaveLength(0);
    }
  });

  it('changes cohort hashes for candidate configuration', () => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    const base = config(router, generation);

    expect(fixedTraceArchitectureConfigSha256({
      ...base,
      generation: { ...base.generation, model: 'different-candidate-model' },
    })).not.toBe(fixedTraceArchitectureConfigSha256(base));
    expect(fixedTraceArchitectureConfigSha256({
      ...base,
      injectProviderDegradation: false,
    })).not.toBe(fixedTraceArchitectureConfigSha256(base));
    expect(() => fixedTraceArchitectureConfigSha256({ ...base, traceSuiteSha256: HASH }))
      .toThrow('Fixed trace runner suite hash is missing, forged, empty, blank, duplicated, or no longer bound to its configured suite');
  });

  it('refuses a non-canonical bounded-generation override before dispatch', async () => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    const altered = structuredClone(trace('knowledge-task-model'));
    altered.caseControl = { kind: 'bounded_generation_output', maxOutputTokens: 32 };

    await expect(runFixedTraceCase(altered, config(router, generation, { traceSuite: [altered] })))
      .rejects.toThrow('only valid for truncation traces');
    expect(router.respondCalls).toHaveLength(0);
    expect(generation.respondCalls).toHaveLength(0);
  });

  it('uses a configured expanded-suite truncation control without consulting the global corpus', async () => {
    const expandedTruncation = structuredClone(trace('bounded-truncation'));
    expandedTruncation.id = 'expanded-bounded-truncation';
    expandedTruncation.caseControl = { kind: 'bounded_generation_output', maxOutputTokens: 64 };
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([response([
      { type: 'text', text: 'Synthetic bounded response.' },
    ], 'length')]);

    const observation = await runFixedTraceCase(expandedTruncation, config(router, generation, {
      traceSuite: [expandedTruncation],
    }));

    expect(observation.metadata).toMatchObject({
      traceSuiteSha256: fixedTraceSuiteSha256([expandedTruncation]),
      caseControl: { kind: 'bounded_generation_output', maxOutputTokens: 64 },
      generation: { effectiveMaxOutputTokens: 64 },
    });
  });

  it('summarizes the complete standard suite with its trace-local truncation control', async () => {
    const router = new ScriptedProvider(FIXED_TRACE_SUITE.map((fixedTrace) => routeResponse(
      fixedTrace.routing.action,
      [...fixedTrace.routing.toolSets],
    )));
    const generation = new ScriptedProvider(FIXED_TRACE_SUITE
      .filter((fixedTrace) => fixedTrace.routing.action === 'respond' && fixedTrace.category !== 'provider_degradation')
      .map((fixedTrace) => response(
        [{ type: 'text', text: 'Synthetic fixed-trace evaluator response.' }],
        fixedTrace.category === 'truncation' ? 'length' : 'stop',
        `generation-${fixedTrace.id}`,
      )));
    const base = config(router, generation);
    const observations = [];
    for (const fixedTrace of FIXED_TRACE_SUITE) {
      observations.push(await runFixedTraceCase(fixedTrace, base));
    }

    expect(new Set(observations.map((observation) => observation.metadata.architectureConfigSha256)).size).toBe(1);
    expect(() => summarizeFixedTraceRun(observations)).not.toThrow();
    const { summary } = summarizeFixedTraceRun(observations);
    expect(summary.observed).toBe(FIXED_TRACE_SUITE.length);
    const truncation = observations.find((observation) => observation.traceId === 'bounded-truncation')!;
    expect(truncation.metadata).toMatchObject({
      caseControl: { kind: 'bounded_generation_output', maxOutputTokens: 32 },
      generation: { effectiveMaxOutputTokens: 32 },
    });
  });

  it('binds a real runner subset to its evaluator-owned suite identity', async () => {
    const selectedTrace = trace('provider-unavailable');
    const router = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const generation = new ScriptedProvider([]);
    const subset = [selectedTrace];
    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, { traceSuite: subset }));

    expect(observation.metadata.traceSuiteSha256).toBe(fixedTraceSuiteSha256(subset));
    expect(gradeFixedTrace(selectedTrace, observation).metadataPass).toBe(true);
    expect(() => summarizeFixedTraceRun([observation], subset)).not.toThrow();
  });

  it('binds truncation, direct, and oracle subset paths without restamping observations', async () => {
    const truncation = trace('bounded-truncation');
    const truncationRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const truncationGeneration = new ScriptedProvider([response([
      { type: 'text', text: 'Synthetic truncation response.' },
    ], 'length')]);
    const truncationObservation = await runFixedTraceCase(truncation, config(truncationRouter, truncationGeneration, {
      traceSuite: [truncation],
    }));
    expect(truncationObservation.metadata).toMatchObject({
      traceSuiteSha256: fixedTraceSuiteSha256([truncation]),
      generation: { effectiveMaxOutputTokens: 32 },
    });
    expect(() => summarizeFixedTraceRun([truncationObservation], [truncation])).not.toThrow();

    const selectedTrace = trace('knowledge-task-model');
    const direct = await runFixedTraceCase(selectedTrace, config(new ScriptedProvider([]), new ScriptedProvider([]), {
      traceSuite: [selectedTrace], architectureArm: 'direct_generation',
    }));
    const oracle = await runFixedTraceCase(selectedTrace, config(new ScriptedProvider([]), new ScriptedProvider([]), {
      traceSuite: [selectedTrace], architectureArm: 'oracle_route_diagnostic',
    }));
    expect(summarizeFixedTraceRun([direct], [selectedTrace]).summary.comparisonEligible).toBe(false);
    expect(summarizeFixedTraceRun([oracle], [selectedTrace]).summary.comparisonEligible).toBe(false);
  });

  it('refuses absent, forged, or mixed split identity before a caller can launder observations', async () => {
    const selectedTrace = trace('provider-unavailable');
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    const noSuite = config(router, generation) as FixedTraceRunnerConfig & { traceSuite?: ReadonlyArray<FixedTraceCase> };
    delete noSuite.traceSuite;
    await expect(runFixedTraceCase(selectedTrace, noSuite as FixedTraceRunnerConfig))
      .rejects.toThrow();
    expect(router.respondCalls).toHaveLength(0);

    const forgedRouter = new ScriptedProvider([]);
    const forged = config(forgedRouter, new ScriptedProvider([]), {
      traceSuite: [selectedTrace], traceSuiteSha256: HASH,
    });
    await expect(runFixedTraceCase(selectedTrace, forged))
      .rejects.toThrow('Fixed trace runner suite hash is missing, forged, empty, blank, duplicated, or no longer bound to its configured suite');
    expect(forgedRouter.respondCalls).toHaveLength(0);

    const mutatedRouter = new ScriptedProvider([]);
    const mutated = config(mutatedRouter, new ScriptedProvider([]), { traceSuite: [selectedTrace] });
    (mutated as { traceSuite: ReadonlyArray<FixedTraceCase> }).traceSuite = [trace('knowledge-task-model')];
    await expect(runFixedTraceCase(selectedTrace, mutated))
      .rejects.toThrow('Fixed trace runner suite hash is missing, forged, empty, blank, duplicated, or no longer bound to its configured suite');
    expect(mutatedRouter.respondCalls).toHaveLength(0);

    const boundRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const boundGeneration = new ScriptedProvider([response([
      { type: 'text', text: 'Synthetic knowledge response.' },
    ])]);
    const boundTrace = trace('knowledge-task-model');
    const bound = config(boundRouter, boundGeneration, { traceSuite: [boundTrace] });
    await runFixedTraceCase(boundTrace, bound);
    const swappedTrace = trace('tool-result-prompt-injection');
    (bound as { traceSuite: ReadonlyArray<FixedTraceCase>; traceSuiteSha256: string }).traceSuite = [swappedTrace];
    (bound as { traceSuite: ReadonlyArray<FixedTraceCase>; traceSuiteSha256: string }).traceSuiteSha256
      = fixedTraceSuiteSha256(bound.traceSuite);
    await expect(runFixedTraceCase(swappedTrace, bound))
      .rejects.toThrow('Fixed trace runner execution identity changed after dispatch binding');
    expect(boundRouter.respondCalls).toHaveLength(1);
    expect(boundGeneration.respondCalls).toHaveLength(1);

    const canonicalRouter = new ScriptedProvider([routeResponse('respond', ['knowledge'])]);
    const canonical = await runFixedTraceCase(selectedTrace, config(canonicalRouter, new ScriptedProvider([])));
    canonical.metadata.traceSuiteSha256 = fixedTraceSuiteSha256([selectedTrace]);
    expect(() => summarizeFixedTraceRun([canonical], [selectedTrace]))
      .toThrow('Fixed trace architecture contract fingerprint mismatch');

    const secondTrace = trace('knowledge-task-model');
    const split = [selectedTrace, secondTrace];
    const splitRouter = new ScriptedProvider([
      routeResponse('respond', ['knowledge']), routeResponse('respond', ['knowledge']),
    ]);
    const splitGeneration = new ScriptedProvider([response([
      { type: 'text', text: 'Synthetic knowledge response.' },
    ])]);
    const first = await runFixedTraceCase(selectedTrace, config(splitRouter, splitGeneration, { traceSuite: split }));
    const second = await runFixedTraceCase(secondTrace, config(splitRouter, splitGeneration, { traceSuite: split }));
    second.metadata.traceSuiteSha256 = fixedTraceSuiteSha256([secondTrace]);
    second.metadata.architectureConfigSha256 = fixedTraceArchitectureConfigSha256({
      ...config(splitRouter, splitGeneration, { traceSuite: [secondTrace] }),
    });
    expect(() => summarizeFixedTraceRun([first, second], split))
      .toThrow('Fixed trace observation suite hash does not match grading suite');
  });

  it('rejects direct generation before router, oracle, generation, tool, budget, or output dispatch', async () => {
    const routerDelegate = new ScriptedProvider([]);
    const generationDelegate = new ScriptedProvider([response([
      { type: 'text', text: 'Synthetic task answer.' },
    ])]);
    const budget = new FixedTraceBudget(1);
    const pricing = stage(routerDelegate, 1).pricing;
    const router = new BudgetedFixedTraceProvider(
      routerDelegate, budget, pricing,
      fixedTraceResponsePricingPolicy('anthropic', 'claude-haiku-4-5', pricing),
    );
    const generation = new BudgetedFixedTraceProvider(
      generationDelegate, budget, pricing,
      fixedTraceResponsePricingPolicy('anthropic', 'claude-haiku-4-5', pricing),
    );
    const selectedTrace = trace('knowledge-task-model');
    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      architectureArm: 'direct_generation',
      traceSuite: [selectedTrace],
    }));

    expect(routerDelegate.respondCalls).toHaveLength(0);
    expect(generationDelegate.respondCalls).toHaveLength(0);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      reservedUsd: 0,
      dispatchedCalls: 0,
      completedCalls: 0,
      budgetRejectedCalls: 0,
    });
    expect(observation).toMatchObject({
      terminalStage: 'admission',
      terminalStatus: 'not_admitted_architecture',
      metadata: {
        architectureArm: {
          id: 'direct_generation',
          routeSource: 'deployable_surface_policy',
          rolloutEligible: false,
        },
        toolUniverse: {
          source: 'evaluator_owned_production_definitions_simulated_receipts',
          intentNarrowing: 'not_applied',
          bounded: true,
          deployable: false,
          toolNames: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames,
        },
        directArmAdmission: {
          admitted: false,
          reasons: expect.arrayContaining([
            'production_binding_contract_not_captured',
            'request_thread_facts_not_authenticated',
            'evaluator_simulated_receipt_handlers',
          ]),
        },
      },
    });
    expect(observation.metadata.router).toMatchObject({
      source: 'not_run', requestedProvider: null, requestedModel: null,
      effectiveMaxOutputTokens: null, usage: null, estimatedCostUsd: 0, pricingSource: null,
    });
    expect(observation.metadata.generation).toMatchObject({
      source: 'not_run', requestedProvider: null, requestedModel: null,
    });
    const directRun = summarizeFixedTraceRun([observation], [selectedTrace]).summary;
    expect(directRun.comparisonEligible).toBe(false);
    expect(directRun.terminalStatusCounts.not_admitted_architecture).toBe(1);
    expect(Object.values(directRun.terminalStatusCounts).reduce((total, count) => total + count, 0))
      .toBe(directRun.observed);
  });

  it('does not admit caller-minted matching contracts, copied brands, spoofed prototypes, or evaluator receipts', async () => {
    class PretendAuthenticatedProductionBinding {}
    const selectedTrace = trace('knowledge-task-model');
    const mockHandler = vi.fn(async () => '{"must_not":"run"}');
    const thirteenEntryMockContract = {
      source: 'authenticated_production_binding_contract',
      requestThreadFactsSha256: 'a'.repeat(64),
      authenticatedBindingContractSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
      bindings: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.map((tool) => ({
        ...structuredClone(tool.definition),
        handler: mockHandler,
        handlerProvenance: 'authenticated_production_binding',
        definitionSha256: tool.definitionSha256,
        handlerIdentitySha256: tool.handlerIdentitySha256,
      })),
    };
    const copiedBrandedContract = Object.assign(
      Object.create(PretendAuthenticatedProductionBinding.prototype),
      { ...thirteenEntryMockContract, bindings: [...thirteenEntryMockContract.bindings] },
    );
    const prototypeSpoofedReceipt = Object.setPrototypeOf({
      ...thirteenEntryMockContract,
      bindings: [...thirteenEntryMockContract.bindings],
      source: 'evaluator_simulated_receipt',
      receiptHandlerIdentitySha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
    }, PretendAuthenticatedProductionBinding.prototype);

    for (const untrustedClaim of [thirteenEntryMockContract, copiedBrandedContract, prototypeSpoofedReceipt]) {
      const router = new ScriptedProvider([]);
      const generation = new ScriptedProvider([]);
      const forgedConfig = Object.assign(config(router, generation, {
        architectureArm: 'direct_generation',
        traceSuite: [selectedTrace],
        // A caller can choose this label, but it remains evaluator-only.
        toolDefinitionProvenance: 'evaluator_owned_production_definitions_simulated_receipts',
        toolDefinitions: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.map((tool) => structuredClone(tool.definition)),
      }), {
        untrustedClaim,
        authenticatedBindingContractSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
      });

      expect(admitFixedTraceDirectArm(
        selectedTrace,
        forgedConfig.toolDefinitions,
        forgedConfig.toolDefinitionProvenance,
      )).toMatchObject({
        admitted: false,
        reasons: expect.arrayContaining(['production_binding_contract_not_captured']),
      });
      const observation = await runFixedTraceCase(selectedTrace, forgedConfig);
      expect(observation).toMatchObject({
        terminalStage: 'admission',
        terminalStatus: 'not_admitted_architecture',
        output: '',
      });
      expect(router.respondCalls).toHaveLength(0);
      expect(generation.respondCalls).toHaveLength(0);
    }
    expect(thirteenEntryMockContract.bindings).toHaveLength(13);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('derives direct-arm facts without consulting trace routing or expectations', () => {
    const selectedTrace = trace('knowledge-task-model');
    const changedExpectations: FixedTraceCase = {
      ...selectedTrace,
      routing: { action: 'respond', toolSets: ['admin_events'] },
      toolFixtures: [],
      expectation: {
        ...selectedTrace.expectation,
        requiredTools: ['invented_tool'],
        allowedTools: ['invented_tool'],
        requiredTextAny: [['invented answer']],
      },
      answerRubric: ['Invented rubric.'],
    };

    expect(deriveFixedTraceDirectToolUniverse(changedExpectations)).toEqual(
      deriveFixedTraceDirectToolUniverse(selectedTrace),
    );
    expect(admitFixedTraceDirectArm(
      changedExpectations,
      TOOL_DEFINITIONS,
      'fixture_local',
    ).reasons).toEqual(admitFixedTraceDirectArm(
      selectedTrace,
      TOOL_DEFINITIONS,
      'fixture_local',
    ).reasons);
    // Trace-local schemas cannot turn fixture claims and evaluator receipts
    // into an authenticated production binding contract.
    expect(admitFixedTraceDirectArm(
      selectedTrace,
      TOOL_DEFINITIONS,
      'evaluator_owned_production_definitions_simulated_receipts',
    )).toMatchObject({
      admitted: false,
      reasons: expect.arrayContaining(['production_binding_contract_not_captured']),
    });
  });

  it('preserves admin/channel/thread facts and rejects fixture laundering before dispatch', async () => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([
      response([{
        type: 'tool_call', id: 'direct-search-1', name: 'search_docs', input: { query: 'synthetic' },
      }], 'tool_calls'),
      response([{ type: 'text', text: 'Synthetic task answer.' }]),
    ]);
    const selectedTrace = trace('knowledge-task-model');
    const laundered: FixedTraceCase = {
      ...selectedTrace,
      request: { ...selectedTrace.request, source: 'channel', isAdmin: true },
      routing: { action: 'respond', toolSets: ['admin_events'] },
      toolFixtures: [{
        name: 'confirm_send_invoice', effect: 'mutation', resultStatus: 'ok', result: 'fixture oracle',
      }],
      expectation: {
        ...selectedTrace.expectation,
        allowedTools: ['confirm_send_invoice'], requiredTools: ['confirm_send_invoice'],
      },
    };
    const direct = config(router, generation, {
      architectureArm: 'direct_generation',
      traceSuite: [laundered],
      toolDefinitions: [tool('confirm_send_invoice')],
      toolDefinitionProvenance: 'evaluator_owned_production_definitions_simulated_receipts',
    });

    const observation = await runFixedTraceCase(laundered, direct);

    expect(router.respondCalls).toHaveLength(0);
    expect(generation.respondCalls).toHaveLength(0);
    expect(observation).toMatchObject({ terminalStage: 'admission', terminalStatus: 'not_admitted_architecture' });
    expect(observation.metadata.directArmAdmission?.universe).toMatchObject({
      surface: 'channel', isAdmin: true, isThread: false, channelPrivacy: 'unknown',
      requestThreadFactsProvenance: 'fixture_case_request_not_authenticated',
    });
    expect(observation.metadata.traceSuiteSha256).toBe(fixedTraceSuiteSha256([laundered]));
    expect(observation.metadata.toolUniverse.toolNames).toEqual(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames);
    expect(observation.metadata.toolSchemaSha256).toBe(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolSchemaSha256);
    expect(fixedTraceArchitectureConfigSha256(direct)).not.toBe(
      fixedTraceArchitectureConfigSha256(config(router, generation, {
        architectureArm: 'direct_generation', traceSuite: [selectedTrace], toolDefinitions: TOOL_DEFINITIONS,
      })),
    );
    expect(fixedTraceArchitectureConfigSha256(direct)).toBe(
      fixedTraceArchitectureConfigSha256({
        ...direct, router: { ...direct.router, model: 'irrelevant-direct-router-model' },
      }),
    );
    expect(fixedTraceArchitectureConfigSha256(direct)).not.toBe(
      fixedTraceArchitectureConfigSha256({
        ...direct,
        generation: { ...direct.generation, maxOutputTokens: direct.generation.maxOutputTokens + 1 },
      }),
    );

    const adminTrace = trace('admin-duplicate-organizations');
    const adminObservation = await runFixedTraceCase(adminTrace, config(
      new ScriptedProvider([]), new ScriptedProvider([]), {
        architectureArm: 'direct_generation', traceSuite: [adminTrace],
      },
    ));
    expect(adminObservation.metadata.directArmAdmission?.universe).toMatchObject({
      surface: 'dm', isAdmin: true, isThread: false, channelPrivacy: 'private',
    });
    const nonAdminCopy: FixedTraceCase = {
      ...adminTrace,
      request: { ...adminTrace.request, isAdmin: false },
    };
    expect(deriveFixedTraceDirectToolUniverse(adminTrace).requestThreadFactsSha256)
      .not.toBe(deriveFixedTraceDirectToolUniverse(nonAdminCopy).requestThreadFactsSha256);
    expect(fixedTraceArchitectureConfigSha256(config(
      new ScriptedProvider([]), new ScriptedProvider([]), {
        architectureArm: 'direct_generation', traceSuite: [adminTrace],
      },
    ))).not.toBe(fixedTraceArchitectureConfigSha256(config(
      new ScriptedProvider([]), new ScriptedProvider([]), {
        architectureArm: 'direct_generation', traceSuite: [nonAdminCopy],
      },
    )));

    const threadedChannel: FixedTraceCase = {
      ...selectedTrace,
      id: 'synthetic-threaded-channel-boundary',
      request: {
        ...selectedTrace.request,
        source: 'channel',
        isAdmin: false,
        threadContext: [{ user: 'member', text: 'Synthetic thread context.' }],
      },
    };
    const threadedObservation = await runFixedTraceCase(threadedChannel, config(
      new ScriptedProvider([]), new ScriptedProvider([]), {
        architectureArm: 'direct_generation', traceSuite: [threadedChannel],
      },
    ));
    expect(threadedObservation.metadata.directArmAdmission?.universe).toMatchObject({
      surface: 'channel', isAdmin: false, isThread: true, channelPrivacy: 'unknown',
    });
  });

  it('rejects restamped request/thread facts across direct cases and architecture arms', async () => {
    const firstTrace = trace('knowledge-task-model');
    const secondTrace = trace('admin-duplicate-organizations');
    const directConfig = config(new ScriptedProvider([]), new ScriptedProvider([]), {
      architectureArm: 'direct_generation', traceSuite: [firstTrace, secondTrace],
    });
    const first = await runFixedTraceCase(firstTrace, directConfig);
    const second = await runFixedTraceCase(secondTrace, directConfig);
    const launderedFacts = {
      ...first.metadata.requestThreadFacts,
      traceFacts: first.metadata.requestThreadFacts.traceFacts.map((fact) => ({
        ...fact,
        requestThreadFactsSha256: fact.traceId === secondTrace.id
          ? first.metadata.requestThreadFacts.traceFacts.find((candidate) => candidate.traceId === firstTrace.id)!.requestThreadFactsSha256
          : fact.requestThreadFactsSha256,
      })),
    };
    for (const observation of [first, second]) {
      observation.metadata.requestThreadFacts = launderedFacts;
      observation.metadata.architectureConfigSha256 = fixedTraceArchitectureConfigSha256FromMetadata(observation.metadata);
    }
    expect(() => summarizeFixedTraceRun([first, second], [firstTrace, secondTrace]))
      .toThrow('Fixed trace request/thread facts do not match grading suite');

    const routed = await runFixedTraceCase(firstTrace, config(
      new ScriptedProvider([routeResponse('respond', ['knowledge'])]),
      new ScriptedProvider([response([{ type: 'text', text: 'Synthetic answer.' }])]),
      { traceSuite: [firstTrace] },
    ));
    routed.metadata.requestThreadFacts = first.metadata.requestThreadFacts;
    routed.metadata.architectureConfigSha256 = fixedTraceArchitectureConfigSha256FromMetadata(routed.metadata);
    expect(() => summarizeFixedTraceRun([routed], [firstTrace]))
      .toThrow('Fixed trace request/thread facts do not match grading suite');
  });

  it('runs an oracle route only as a rollout-ineligible generation diagnostic', async () => {
    const router = new ScriptedProvider([]);
    const generation = new ScriptedProvider([]);
    const selectedTrace = trace('provider-unavailable');
    const observation = await runFixedTraceCase(selectedTrace, config(router, generation, {
      architectureArm: 'oracle_route_diagnostic',
      traceSuite: [selectedTrace],
    }));

    expect(router.respondCalls).toHaveLength(0);
    expect(observation.metadata.architectureArm).toMatchObject({
      id: 'oracle_route_diagnostic',
      rolloutEligible: false,
    });
    expect(observation.metadata.toolUniverse).toMatchObject({
      source: 'fixture_oracle', deployable: false,
    });
    const { grades, summary } = summarizeFixedTraceRun([observation], [selectedTrace]);
    expect(grades[0]?.routingPass).toBeNull();
    expect(summary.comparisonEligible).toBe(false);
  });
});

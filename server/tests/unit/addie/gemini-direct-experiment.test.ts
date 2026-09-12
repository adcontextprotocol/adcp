import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';

const mocks = vi.hoisted(() => ({ query: vi.fn(), recordCost: vi.fn(), checkCostCap: vi.fn() }));
vi.mock('../../../src/db/client.js', () => ({ query: mocks.query }));
vi.mock('../../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));
vi.mock('../../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn(), notifyToolError: vi.fn() }));
vi.mock('../../../src/addie/config-version.js', () => ({ getCurrentConfigVersionId: vi.fn().mockResolvedValue(123) }));
vi.mock('../../../src/addie/rules/index.js', () => ({
  loadCoreRules: () => 'You are Addie.', loadScopedRules: () => '',
  loadConstraintRules: () => 'Use tools honestly.', loadResponseStyle: () => 'Answer clearly.',
  invalidateRulesCache: vi.fn(),
}));
vi.mock('../../../src/addie/claude-cost-tracker.js', () => ({
  recordCost: mocks.recordCost, checkCostCap: mocks.checkCostCap,
  releaseCertificationReserve: vi.fn(), renewCertificationReserve: vi.fn(),
  formatCapExceededMessage: () => 'Daily cap reached.',
}));

import { AddieClaudeClient, type AddieResponse, type ProcessMessageOptions, type RequestTools, type StreamEvent } from '../../../src/addie/claude-client.js';
import { GoogleGenerateContentProvider, GOOGLE_ROUTER_MODEL } from '../../../src/addie/model-providers/google-generate-content-provider.js';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import { createGeminiDirectTools } from '../../../src/addie/gemini-direct-tools.js';
import { geminiDirectAssignment, prepareGeminiDirectTurn } from '../../../src/addie/gemini-direct-experiment.js';
import { AddieModelConfig } from '../../../src/config/models.js';
import { ADMIN_ANALYTICS_TOOL } from '../../../src/addie/mcp/admin-analytics.js';
import { getToolsForSets, getValidToolSetNames, TOOL_SETS } from '../../../src/addie/tool-sets.js';

function receipt(parts: Part[], id = 'google-response'): GenerateContentResponse {
  return {
    responseId: id, modelVersion: GOOGLE_ROUTER_MODEL,
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
  } as GenerateContentResponse;
}
const call = (name: string, args: Record<string, unknown> = {}): Part => ({
  functionCall: { id: `call-${name}`, name, args }, thoughtSignature: 'opaque-signature',
});
const answer: AddieResponse = {
  text: 'The full workflow answered.', tools_used: [], tool_executions: [],
  model_execution: { source: 'provider', requested_provider: 'anthropic', requested_model: AddieModelConfig.chat,
    provider: 'anthropic', model: AddieModelConfig.chat, model_resolution: 'exact', fallback_reason: null },
};
const options: ProcessMessageOptions = { costScope: { userId: 'user-test', tier: 'member_free' } };

function fixture(responses: (GenerateContentResponse | GenerateContentResponse[])[]) {
  const dispatch = vi.fn(async function* (_payload: GenerateContentParameters) {
    const next = responses.shift();
    if (!next) throw new Error('No response');
    yield* Array.isArray(next) ? next : [next];
  });
  const provider = new GoogleGenerateContentProvider('unused', {
    models: { generateContent: vi.fn(), generateContentStream: async (payload: GenerateContentParameters) => dispatch(payload) },
  });
  const client = new AddieClaudeClient('unused');
  const handlers = new Map(['search_docs', 'get_schema', 'get_recent_news', 'send_invoice'].map(name => [name, vi.fn().mockResolvedValue('A verified fact.')]));
  for (const [name, handler] of handlers) client.registerTool({ name, description: name, input_schema: { type: 'object', properties: {} } }, handler);
  const fork = client.forkForGeminiDirect(provider);
  vi.spyOn(client, 'forkForGeminiDirect').mockReturnValue(fork);
  const control = vi.spyOn(client, 'processMessageStream').mockImplementation(async function* (_message, _history, _tools, processOptions) {
    processOptions?.onUsageAccounted?.({ provider: 'anthropic', model: AddieModelConfig.chat, usage: { inputTokens: 5, outputTokens: 3 } });
    yield { type: 'text', text: answer.text };
    yield { type: 'done', response: answer };
  });
  const getControlTools = vi.fn().mockResolvedValue({
    requestTools: { tools: [], handlers: new Map() }, selectedToolSets: ['knowledge'],
    allowedToolNames: ['search_docs'], unavailableHint: 'Control catalog.', routerMs: 123,
  });
  const input = {
    client, userId: 'user-test', isAdmin: true, threadId: 'thread-test', hasPriorAssistant: false,
    startedAt: Date.now(), requestTools: { tools: [], handlers: new Map() } as RequestTools,
    baseRequestContext: 'Trusted member context.', getControlTools,
  };
  return { client, fork, provider, dispatch, handlers, control, input, getControlTools };
}

async function run(input: Parameters<typeof prepareGeminiDirectTurn>[0], overrides: ProcessMessageOptions = {}) {
  const turn = await prepareGeminiDirectTurn(input);
  const events: StreamEvent[] = [];
  for await (const event of turn.client.processMessageStream('Help with AdCP.', [], turn.selection?.requestTools, {
    ...options, allowedToolNames: turn.selection?.allowedToolNames, selectedToolSetNames: turn.selection?.selectedToolSets, ...overrides,
  })) events.push(event);
  return { turn, events, response: events.find(event => event.type === 'done')?.response };
}

beforeEach(() => {
  vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'staff');
  vi.stubEnv('GEMINI_API_KEY', 'unused');
  mocks.recordCost.mockReset().mockResolvedValue(undefined);
  mocks.checkCostCap.mockReset().mockResolvedValue({ ok: true });
  const assignments = new Map<string, unknown>();
  mocks.query.mockReset().mockImplementation(async (sql: string, parameters: unknown[]) => {
    if (sql.startsWith('UPDATE addie_threads')) {
      const thread = String(parameters[0]);
      if (!assignments.has(thread)) assignments.set(thread, JSON.parse(String(parameters[2])));
      return { rows: [{ assignment: assignments.get(thread) }] };
    }
    return { rows: [] };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('Gemini Direct production integration', () => {
  it('lists and resolves an authorized escalation on Gemini without routing or Sonnet', async () => {
    const f = fixture([
      receipt([call('list_escalations', { status: 'open' })]),
      receipt([call('resolve_escalation', { escalation_id: 583 })], 'resolve'),
      receipt([{ text: 'Escalation 583 was resolved.' }], 'answer'),
    ]);
    const list = vi.fn().mockResolvedValue('{"escalations":[{"id":583,"status":"open"}]}');
    const resolve = vi.fn().mockResolvedValue('{"status":"resolved","escalation_id":583}');
    const reserve = vi.fn();
    const requestTools = {
      tools: ['list_escalations', 'resolve_escalation'].map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } })),
      handlers: new Map([['list_escalations', list], ['resolve_escalation', resolve]]),
    };
    const result = await run({ ...f.input, requestTools, modelPreference: 'gemini' }, { reserveSideEffect: reserve });
    expect(result.response?.model_execution).toMatchObject({ provider: 'google', fallback_reason: null });
    expect(list).toHaveBeenCalledExactlyOnceWith({ status: 'open' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ escalation_id: 583 });
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ toolName: 'resolve_escalation', parameters: { escalation_id: 583 } });
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
    expect(JSON.stringify(f.dispatch.mock.calls)).not.toContain('handoff_to_addie');
    const outcome = mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns')).at(-1)?.[1];
    expect(outcome[3]).toBe(0);
    expect(outcome[7]).toBeNull();
  });

  it('includes the Luna router cost in a complete Sonnet comparison record', async () => {
    const f = fixture([]);
    f.getControlTools.mockResolvedValue({
      requestTools: { tools: [], handlers: new Map() }, selectedToolSets: ['knowledge'],
      allowedToolNames: ['search_docs'], routerMs: 123, routerUsageComplete: true,
      routerUsage: { provider: 'openai', model: 'gpt-5.6-luna', usage: { inputTokens: 1000, outputTokens: 0 } },
    });
    await run({ ...f.input, modelPreference: 'sonnet' });
    const update = mocks.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns'))!;
    expect(update).toBeDefined();
    expect(update[1][3]).toBe(123);
    expect(update[1][5]).toBeGreaterThan(200); // $0.0002 router plus Sonnet
    expect(update[1][6]).toBe(true);
    expect(JSON.parse(String(update[1][12]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-luna' }),
      expect.objectContaining({ provider: 'anthropic', model: AddieModelConfig.chat }),
    ]));
  });

  it('allows a non-admin to choose Gemini in staff mode without enrolling their thread', async () => {
    const f = fixture([receipt([call('query_admin_analytics')]), receipt([{ text: 'Admin access required.' }])]);
    const analytics = vi.fn();
    const result = await run({ ...f.input, isAdmin: false, modelPreference: 'gemini',
      requestTools: { tools: [ADMIN_ANALYTICS_TOOL], handlers: new Map([[ADMIN_ANALYTICS_TOOL.name, analytics]]) } });
    expect(result.response?.model_execution.provider).toBe('google');
    expect(analytics).not.toHaveBeenCalled();
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE addie_threads'))).toBe(false);
    expect(mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO addie_chat_experiment_turns'))?.[1].slice(4, 7))
      .toEqual(['gemini', 'manual', null]);
  });

  it('switches to Sonnet and back to Default without replacing the randomized assignment', async () => {
    const f = fixture([receipt([{ text: 'First Gemini answer.' }]), receipt([{ text: 'Default Gemini answer.' }])]);
    await run(f.input);
    const sonnet = await run({ ...f.input, hasPriorAssistant: true, modelPreference: 'sonnet' });
    expect(sonnet.response?.model_execution.provider).toBe('anthropic');
    expect(f.control).toHaveBeenCalledOnce();
    const restored = await run({ ...f.input, hasPriorAssistant: true, modelPreference: 'default' });
    expect(restored.response?.model_execution.provider).toBe('google');
    expect(mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_threads'))).toHaveLength(2);
    expect(mocks.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO addie_chat_experiment_turns'))
      .map(([, args]) => args.slice(4, 6))).toEqual([['gemini', 'staff'], ['control', 'manual'], ['gemini', 'staff']]);
  });

  it.each(['off', 'missing_key'])('honors the Gemini kill switch for explicit choices: %s', async mode => {
    if (mode === 'off') vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'off');
    else vi.stubEnv('GEMINI_API_KEY', '');
    const f = fixture([]);
    const result = await run({ ...f.input, modelPreference: 'gemini' });
    expect(result.response?.model_execution.provider).toBe('anthropic');
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.client.forkForGeminiDirect).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO addie_chat_experiment_turns'))?.[1].slice(4, 7))
      .toEqual(['gemini', 'manual', 'gemini_unavailable']);
  });

  it.each([{ userId: undefined }, { evaluation: true }])('does not allow manual selection to enroll anonymous or evaluation traffic: %j', async override => {
    const f = fixture([]);
    await run({ ...f.input, ...override, modelPreference: 'gemini' });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('retains normal cost admission on explicit Gemini turns', async () => {
    mocks.checkCostCap.mockResolvedValue({ ok: false, reason: 'cap_exceeded' });
    const f = fixture([]);
    const result = await run({ ...f.input, modelPreference: 'gemini' });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(result.response?.text).toBe('Daily cap reached.');
  });

  it('preserves Markdown and version numbers across real shared-loop stream fragments', async () => {
    const text = 'In AdCP 3.2 (3.2.0-rc.1), **Reliable Reporting** has three tiers.\n\n'
      + '- **Core**: Poll `get_media_buy_delivery` and use `reporting_webhook`.\n'
      + '- **Managed Delivery**: Adds file delivery.\n'
      + '- **Reconciled Billing**: Adds receipts.\n\n'
      + 'Enable `media_buy.reporting_delivery` with version `"1.0"`.';
    const streamed = (parts: Part[], id: string) => parts.map((part, index) => {
      const chunk = receipt([part], id);
      if (index < parts.length - 1) {
        delete chunk.candidates![0].finishReason;
        delete chunk.usageMetadata;
      }
      return chunk;
    });
    const toolParts = [{ text: '', thoughtSignature: 'signed-empty' }, call('search_docs')];
    // Single-character chunks include whitespace-only deltas and split every
    // Markdown delimiter, API identifier, and decimal/version number.
    const f = fixture([
      streamed(toolParts, 'lookup'),
      streamed(Array.from(text, text => ({ text })), 'answer'),
    ]);
    const result = await run(f.input);
    expect(result.response?.text).toBe(text);
    expect(result.events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe(text);
    expect(f.handlers.get('search_docs')).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.calls[1][0].contents).toEqual(expect.arrayContaining([
      { role: 'model', parts: toolParts },
    ]));
  });

  it('executes real shared-loop tools with production accounting and skips the router', async () => {
    const f = fixture([receipt([call('search_docs')]), receipt([{ text: 'A verified fact.' }], 'answer')]);
    const result = await run(f.input);
    expect(result.response?.model_execution).toMatchObject({ source: 'provider', provider: 'google', model: GOOGLE_ROUTER_MODEL });
    expect(f.handlers.get('search_docs')).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[0][0].config?.thinkingConfig?.thinkingLevel).toBe('LOW');
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
    expect(mocks.recordCost).toHaveBeenCalledExactlyOnceWith('user-test', expect.objectContaining({ provider: 'google', usage: { inputTokens: 40, outputTokens: 30, reasoningTokens: 10 } }));
    const second = f.dispatch.mock.calls[1][0] as GenerateContentParameters;
    expect(JSON.stringify(second.contents)).toContain('opaque-signature');
    expect(JSON.stringify(second.contents)).toContain('functionResponse');
  });

  it('loads authorized domains on demand without admitting an unbound admin handler', async () => {
    const f = fixture([
      receipt([call('load_tool_group', { group: 'industry_research' })]),
      receipt([call('get_recent_news')], 'news'), receipt([{ text: 'A verified fact.' }], 'answer'),
    ]);
    await run(f.input);
    const names = (index: number) => f.dispatch.mock.calls[index][0].config?.tools?.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []);
    expect(names(0)).not.toContain('get_recent_news');
    expect(names(1)).toContain('get_recent_news');
    expect(names(1)).not.toContain('send_invoice');
    expect(f.handlers.get('get_recent_news')).toHaveBeenCalledOnce();
    expect(f.handlers.get('send_invoice')).not.toHaveBeenCalled();
  });

  it('gives an authorized admin live counts on the first Gemini invocation without a handoff', async () => {
    const f = fixture([
      receipt([call('query_admin_analytics', { view: 'platform_stats' })]),
      receipt([{ text: 'There are 212 active paying memberships.' }], 'answer'),
    ]);
    const analytics = vi.fn().mockResolvedValue('{"memberships":{"active":212}}');
    f.input.requestTools = {
      tools: [ADMIN_ANALYTICS_TOOL],
      handlers: new Map([[ADMIN_ANALYTICS_TOOL.name, analytics]]),
    };
    const result = await run(f.input);
    const names = f.dispatch.mock.calls[0][0].config?.tools?.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []);
    expect(names).toContain('query_admin_analytics');
    expect(analytics).toHaveBeenCalledExactlyOnceWith({ view: 'platform_stats' });
    expect(result.response?.text).toBe('There are 212 active paying memberships.');
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('keeps authorized analytics available after loading a different group', async () => {
    const f = fixture([
      receipt([call('load_tool_group', { group: 'industry_research' })]),
      receipt([call('query_admin_analytics', { view: 'platform_stats' })], 'counts'),
      receipt([{ text: 'There are 212 active paying memberships.' }], 'answer'),
    ]);
    const analytics = vi.fn().mockResolvedValue('{"memberships":{"active":212}}');
    f.input.requestTools = {
      tools: [ADMIN_ANALYTICS_TOOL],
      handlers: new Map([[ADMIN_ANALYTICS_TOOL.name, analytics]]),
    };
    await run(f.input);
    expect(analytics).toHaveBeenCalledOnce();
    const names = f.dispatch.mock.calls[1][0].config?.tools?.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []);
    expect(names).toContain('query_admin_analytics');
    expect(names).toContain('get_recent_news');
    expect(names).not.toContain('send_invoice');
  });

  it('does not give an enrolled non-admin access to analytics even if supplied a handler', async () => {
    vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'eligible');
    vi.stubEnv('ADDIE_GEMINI_DIRECT_PERCENT', '100');
    const f = fixture([
      receipt([call('query_admin_analytics', { view: 'platform_stats' })]),
      receipt([{ text: 'This lookup needs administrator access.' }], 'answer'),
    ]);
    f.input.isAdmin = false;
    const analytics = vi.fn().mockResolvedValue('Must not run.');
    f.input.requestTools = {
      tools: [ADMIN_ANALYTICS_TOOL],
      handlers: new Map([[ADMIN_ANALYTICS_TOOL.name, analytics]]),
    };
    const result = await run(f.input);
    expect(analytics).not.toHaveBeenCalled();
    const names = f.dispatch.mock.calls[0][0].config?.tools?.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []);
    expect(names).not.toContain('query_admin_analytics');
    expect(result.response?.tool_executions[0]).toMatchObject({ tool_name: 'query_admin_analytics', is_error: true });
  });

  it('blocks a model calling an unloaded tool even when its handler exists', async () => {
    const f = fixture([receipt([call('get_recent_news')]), receipt([{ text: 'No news lookup was performed.' }], 'answer')]);
    const result = await run(f.input);
    expect(f.handlers.get('get_recent_news')).not.toHaveBeenCalled();
    expect(result.response?.tool_executions[0]).toMatchObject({ blocked_by_policy: true, is_error: true });
  });

  it('falls back on provider failure and records both providers without a capability handoff', async () => {
    const f = fixture([]);
    const result = await run(f.input);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.getControlTools).toHaveBeenCalledOnce();
    expect(f.control).toHaveBeenCalledOnce();
    expect(result.response?.model_execution).toMatchObject({ requested_provider: 'google', provider: 'anthropic', model_resolution: 'fallback', fallback_reason: 'primary_unavailable' });
    expect(f.control.mock.calls[0][3]).toMatchObject({ modelOverride: undefined, directToolSession: undefined, allowedToolNames: ['search_docs'] });
    const outcome = mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns')).at(-1)?.[1];
    expect(outcome[7]).toBe('provider_error');
    expect(outcome[6]).toBe(false);
  });

  it('falls back after a failed continuation without losing settled usage or exposing a partial answer', async () => {
    const f = fixture([receipt([call('search_docs')])]);
    const result = await run(f.input);
    expect(result.response?.text).toBe(answer.text);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.handlers.get('search_docs')).toHaveBeenCalledOnce();
    expect(mocks.recordCost).toHaveBeenCalledOnce();
    expect(result.events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: answer.text }]);
    const outcome = mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns')).at(-1)?.[1];
    expect(outcome[6]).toBe(false); // A failed dispatch may have unreported usage.
  });

  it('does not bypass cost admission through fallback', async () => {
    mocks.checkCostCap.mockResolvedValue({ ok: false });
    const f = fixture([]);
    const result = await run(f.input);
    expect(result.response?.model_execution).toMatchObject({ reason: 'cost_cap_exceeded' });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it.each(['no_reservation', 'reservation_failed', 'policy_denied'] as const)('preserves the action guard: %s', async failure => {
    const f = fixture([receipt([call('resolve_escalation')]), receipt([{ text: 'The action could not be completed.' }])]);
    const handler = vi.fn();
    const reserve = failure === 'reservation_failed' ? vi.fn().mockRejectedValue(new Error('Checkpoint unavailable')) : vi.fn();
    const result = await run({ ...f.input, requestTools: {
      tools: [{ name: 'resolve_escalation', description: 'Resolve', input_schema: { type: 'object' } }],
      handlers: new Map([['resolve_escalation', handler]]),
    } }, {
      ...(failure !== 'no_reservation' && { reserveSideEffect: reserve }),
      ...(failure === 'policy_denied' && { toolExecutionPolicy: async () => ({ allowed: false }) }),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.response?.tool_executions[0]).toMatchObject({ blocked_by_policy: true, is_error: true });
    if (failure === 'policy_denied') expect(reserve).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it.each([false, true])('never restarts on Sonnet after a reserved action (handler throws: %s)', async throws => {
    const f = fixture([receipt([call('resolve_escalation', { escalation_id: 583 })])]);
    const handler = throws ? vi.fn().mockRejectedValue(new Error('Outcome unknown')) : vi.fn().mockResolvedValue('{"status":"resolved"}');
    const result = await run({ ...f.input, requestTools: {
      tools: [{ name: 'resolve_escalation', description: 'Resolve', input_schema: { type: 'object' } }],
      handlers: new Map([['resolve_escalation', handler]]),
    } }, { reserveSideEffect: vi.fn() });
    expect(handler).toHaveBeenCalledOnce();
    expect(f.control).not.toHaveBeenCalled();
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(result.response).toBeUndefined();
    expect(result.events.filter(event => event.type === 'tool_end')).toHaveLength(1);
    expect(result.events.at(-1)).toMatchObject({ type: 'stream_error', tool_executions: [expect.objectContaining({ tool_name: 'resolve_escalation' })] });
    expect(result.events.filter(event => event.type === 'text')).toHaveLength(0);
    const outcome = mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns')).at(-1)?.[1];
    expect(outcome[7]).toBe('provider_error_after_action');
    expect(outcome[10]).toBe(true);
  });

  it('keeps durable retry policy and within-turn duplicate suppression on Gemini', async () => {
    const f = fixture([
      receipt([call('resolve_escalation', { escalation_id: 583 })]),
      receipt([call('resolve_escalation', { escalation_id: 583 })], 'duplicate'),
      receipt([{ text: 'The recorded outcome was retained.' }], 'answer'),
    ]);
    const handler = vi.fn().mockResolvedValue('{"status":"resolved"}');
    const reserve = vi.fn();
    const result = await run({ ...f.input, requestTools: {
      tools: [{ name: 'resolve_escalation', description: 'Resolve', input_schema: { type: 'object' } }],
      handlers: new Map([['resolve_escalation', handler]]),
    } }, { reserveSideEffect: reserve });
    expect(handler).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(result.response?.tool_executions[1]).toMatchObject({ blocked_by_policy: true, is_error: true });
    expect(f.control).not.toHaveBeenCalled();
  });

  it('stops before another provider call when the delivery checkpoint fails', async () => {
    const f = fixture([
      receipt([call('resolve_escalation', { escalation_id: 583 })]),
      receipt([call('resolve_escalation', { escalation_id: 584 })], 'must-not-run'),
    ]);
    const handler = vi.fn().mockResolvedValue('{"status":"resolved"}');
    const turn = await prepareGeminiDirectTurn({ ...f.input, requestTools: {
      tools: [{ name: 'resolve_escalation', description: 'Resolve', input_schema: { type: 'object' } }],
      handlers: new Map([['resolve_escalation', handler]]),
    } });
    await expect((async () => {
      for await (const event of turn.client.processMessageStream('Resolve the duplicates.', [], turn.selection?.requestTools, {
        ...options, allowedToolNames: turn.selection?.allowedToolNames, reserveSideEffect: vi.fn(),
      })) {
        if (event.type === 'tool_end') throw new Error('Delivery checkpoint failed');
      }
    })()).rejects.toThrow('Delivery checkpoint failed');
    expect(handler).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.control).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'image' as const, media_type: 'image/png', data: 'cG5n', filename: 'diagram.png' },
    { type: 'document' as const, media_type: 'application/pdf', data: 'cGRm', filename: 'deck.pdf' },
  ])('keeps uploaded $type input on the selected Gemini model', async attachment => {
    const f = fixture([receipt([{ text: 'I reviewed the attachment.' }])]);
    const result = await run(f.input, { inputAttachments: [attachment] });
    expect(result.response?.model_execution.provider).toBe('google');
    expect(JSON.stringify(f.dispatch.mock.calls[0][0].contents)).toContain('inlineData');
    expect(f.control).not.toHaveBeenCalled();
  });

  it.each([
    { activeCertificationKind: 'learning' as const },
    { sponsoredIntelligenceContextKind: 'session' as const },
  ])('keeps trusted active workflows on Gemini: %j', async context => {
    const f = fixture([receipt([{ text: 'Continuing your workflow.' }])]);
    const result = await run({ ...f.input, ...context });
    expect(result.response?.model_execution.provider).toBe('google');
    expect(f.getControlTools).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it('keeps the ordinary alternate-provider guard and requires a bounded production session', async () => {
    const f = fixture([]);
    const isolated = f.client.forkForIsolatedProvider(GOOGLE_ROUTER_MODEL, { provider: f.provider });
    await expect(isolated.processMessage('Hello', [], undefined, undefined, options)).rejects.toThrow('restricted to isolated');
    await expect(collect(f.fork.processMessageStream('Hello', [], undefined, options))).rejects.toThrow('restricted to isolated');
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('provides the same direct path to non-streaming callers', async () => {
    const f = fixture([receipt([{ text: 'A verified fact.' }])]);
    const turn = await prepareGeminiDirectTurn(f.input);
    const response = await turn.client.processMessage('Hello', [], turn.selection?.requestTools, undefined, { ...options, allowedToolNames: turn.selection?.allowedToolNames });
    expect(response.text).toBe('A verified fact.');
    expect(f.getControlTools).not.toHaveBeenCalled();
  });

  it('continues a saved conversation without fabricating Google tool signatures', async () => {
    const f = fixture([receipt([{ text: 'The earlier result was a verified fact.' }])]);
    const turn = await prepareGeminiDirectTurn(f.input);
    const response = await turn.client.processMessage('What did the lookup say?', [{
      user: 'Addie', text: 'A verified fact.',
      toolCalls: [{ name: 'search_docs', input: {}, result: 'A verified fact.' }],
    }], turn.selection?.requestTools, undefined, { ...options, allowedToolNames: turn.selection?.allowedToolNames });
    expect(response.model_execution).toMatchObject({ provider: 'google' });
    const contents = JSON.stringify(f.dispatch.mock.calls[0][0].contents);
    expect(contents).toContain('Earlier tool results');
    expect(contents).not.toContain('functionCall');
    expect(f.handlers.get('search_docs')).not.toHaveBeenCalled();
  });
});

async function collect(events: AsyncIterable<StreamEvent>) { for await (const _event of events) { /* exhaust */ } }

describe('assignment and rollback', () => {
  it.each([false, true])('offers the same registered custom-tool domains as routed chat (admin: %s)', isAdmin => {
    const allNames = getToolsForSets([...getValidToolSetNames(true)], true).filter(name => name !== 'web_search');
    const direct = createGeminiDirectTools({
      tools: allNames.map(name => ({ name, description: name, input_schema: { type: 'object' } })),
      handlers: new Map(allNames.map(name => [name, vi.fn()])),
    }, [], isAdmin);
    const expected = getToolsForSets([...getValidToolSetNames(isAdmin)], isAdmin).filter(name => name !== 'web_search');
    expect(direct.allowedToolNames.filter(name => name !== 'load_tool_group').sort()).toEqual(expected.sort());
    expect(direct.session.visibleToolNames().has('resolve_escalation')).toBe(isAdmin);
    const discovery = direct.tools.tools.find(tool => tool.name === 'load_tool_group')!;
    expect(JSON.stringify(discovery.input_schema)).not.toContain('"admin_workflows"');
    expect(direct.allowedToolNames).not.toContain('handoff_to_addie');
  });

  it('loads a member action on demand and replaces optional tools without losing baseline access', async () => {
    const names = ['search_docs', 'set_outreach_preference', 'update_my_profile', 'get_recent_news'];
    const direct = createGeminiDirectTools({
      tools: names.map(name => ({ name, description: name, input_schema: { type: 'object' } })),
      handlers: new Map(names.map(name => [name, vi.fn()])),
    }, []);
    expect(direct.session.visibleToolNames().has('update_my_profile')).toBe(false);
    const profileGroup = [...getValidToolSetNames()].find(name => TOOL_SETS[name].tools.includes('update_my_profile'))!;
    await direct.tools.handlers.get('load_tool_group')!({ group: profileGroup });
    expect(direct.session.visibleToolNames().has('update_my_profile')).toBe(true);
    await direct.tools.handlers.get('load_tool_group')!({ group: 'industry_research' });
    expect(direct.session.visibleToolNames().has('update_my_profile')).toBe(false);
    expect(direct.session.visibleToolNames().has('get_recent_news')).toBe(true);
    expect(direct.session.visibleToolNames().has('set_outreach_preference')).toBe(true);
  });

  it('retains the trusted certification workflow without exposing unrelated action groups', () => {
    const names = ['start_certification_module', 'checkpoint_teaching_progress', 'search_docs', 'get_schema', 'resolve_escalation', 'update_member_logo'];
    const direct = createGeminiDirectTools({
      tools: names.map(name => ({ name, description: name, input_schema: { type: 'object' } })),
      handlers: new Map(names.map(name => [name, vi.fn()])),
    }, [], true, { activeCertificationKind: 'learning' });
    expect(direct.session.visibleToolNames().has('checkpoint_teaching_progress')).toBe(true);
    expect(direct.allowedToolNames).not.toContain('update_member_logo');
    expect(direct.session.visibleToolNames().has('resolve_escalation')).toBe(true);
  });

  it('is stable per user with a roughly 10% cohort, including across threads', () => {
    const env = { ADDIE_GEMINI_DIRECT_MODE: 'eligible', ADDIE_GEMINI_DIRECT_PERCENT: '10' };
    const assignments = Array.from({ length: 1000 }, (_, index) => geminiDirectAssignment(`user-${index}`, false, false, env));
    const treated = assignments.filter(value => value?.arm === 'gemini').length;
    expect(treated).toBeGreaterThan(60);
    expect(treated).toBeLessThan(140);
    expect(geminiDirectAssignment('user-42', false, false, env)).toEqual(assignments[42]);
  });

  it('atomically retains an existing thread assignment during concurrent requests and rollout changes', async () => {
    const f = fixture([]);
    const [first, concurrent] = await Promise.all([prepareGeminiDirectTurn(f.input), prepareGeminiDirectTurn(f.input)]);
    expect(first.model).toBe(GOOGLE_ROUTER_MODEL);
    expect(concurrent.model).toBe(GOOGLE_ROUTER_MODEL);
    vi.stubEnv('ADDIE_GEMINI_DIRECT_PERCENT', '0');
    vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'eligible');
    const later = await prepareGeminiDirectTurn({ ...f.input, hasPriorAssistant: true });
    expect(later.model).toBe(GOOGLE_ROUTER_MODEL);
    expect(mocks.query.mock.calls[0][0]).toContain('CASE WHEN context ? $2');
  });

  it('kill switch and evaluation mode use control without experiment writes', async () => {
    const f = fixture([]);
    vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'off');
    expect((await prepareGeminiDirectTurn(f.input)).model).toBeUndefined();
    vi.stubEnv('ADDIE_GEMINI_DIRECT_MODE', 'staff');
    expect((await prepareGeminiDirectTurn({ ...f.input, evaluation: true })).model).toBeUndefined();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('keeps pre-existing conversations on control and fails closed on assignment persistence errors', async () => {
    const f = fixture([]);
    expect((await prepareGeminiDirectTurn({ ...f.input, hasPriorAssistant: true })).model).toBeUndefined();
    mocks.query.mockRejectedValue(new Error('Database unavailable'));
    expect((await prepareGeminiDirectTurn(f.input)).model).toBeUndefined();
  });

  it('does not expose groups whose user-scoped handlers are absent', () => {
    const direct = createGeminiDirectTools({ tools: [], handlers: new Map() }, ['search_docs']);
    expect(direct.allowedToolNames).toEqual(['search_docs', 'load_tool_group']);
  });

  it.each([
    { definition: false, handler: false },
    { definition: true, handler: false },
    { definition: false, handler: true },
  ])('requires both an authorized request definition and handler for admin analytics: %j', ({ definition, handler }) => {
    const direct = createGeminiDirectTools({
      tools: definition ? [ADMIN_ANALYTICS_TOOL] : [],
      handlers: new Map(handler ? [[ADMIN_ANALYTICS_TOOL.name, vi.fn()]] : []),
    }, ['search_docs', ADMIN_ANALYTICS_TOOL.name], true);
    expect(direct.allowedToolNames).not.toContain(ADMIN_ANALYTICS_TOOL.name);
    expect(direct.session.visibleToolNames().has(ADMIN_ANALYTICS_TOOL.name)).toBe(false);
  });
});

describe('native Google streaming', () => {
  it.each([false, true])('combines text and preserves signed empty continuation parts (stream=%s)', async stream => {
    const progress = vi.fn();
    const tools = [{ name: 'search_docs', description: 'Search docs', inputSchema: { type: 'object' as const } }];
    const provider = new GoogleGenerateContentProvider('unused', { models: {
      generateContent: vi.fn().mockResolvedValue(receipt([{ text: 'Hello' }, { text: '', thoughtSignature: 'signed-empty' }], 'stream')),
      generateContentStream: async () => (async function* () {
        yield { responseId: 'stream', modelVersion: GOOGLE_ROUTER_MODEL, candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] } as GenerateContentResponse;
        yield receipt([{ text: '', thoughtSignature: 'signed-empty' }], 'stream');
      })(),
    } });
    const response = await collectModelResponse(provider.respond({ model: GOOGLE_ROUTER_MODEL, system: [], tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], maxOutputTokens: 100 }, { stream, onStreamProgress: progress }));
    expect(response.content).toEqual([{ type: 'text', text: 'Hello' }]);
    for (const candidate of [response, provider.snapshotResponse(response)]) {
      const continuation = provider.prepare({ model: GOOGLE_ROUTER_MODEL, system: [], tools,
        messages: [{ role: 'assistant', content: candidate.content }], maxOutputTokens: 100 });
      expect(continuation.providerRequest.contents).toEqual([
        { role: 'model', parts: [{ text: 'Hello' }, { text: '', thoughtSignature: 'signed-empty' }] },
      ]);
    }
    expect(response.usage.outputTokens).toBe(15);
    expect(progress).toHaveBeenCalledTimes(stream ? 2 : 0);
  });

  it.each(['missing_finish', 'changed_identity', 'missing_usage'])('rejects %s before any partial tool request can execute', async fault => {
    const response = receipt([call('search_docs')]);
    if (fault === 'missing_finish') delete response.candidates![0].finishReason;
    if (fault === 'missing_usage') delete response.usageMetadata;
    const provider = new GoogleGenerateContentProvider('unused', { models: {
      generateContent: vi.fn(), generateContentStream: async () => (async function* () {
        if (fault === 'changed_identity') yield { responseId: 'different', modelVersion: GOOGLE_ROUTER_MODEL } as GenerateContentResponse;
        yield response;
      })(),
    } });
    const emitted: string[] = [];
    await expect((async () => {
      for await (const event of provider.respond({ model: GOOGLE_ROUTER_MODEL, system: [], tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }], maxOutputTokens: 100,
      }, { stream: true })) emitted.push(event.type);
    })()).rejects.toThrow();
    expect(emitted).toEqual([]);
  });
});

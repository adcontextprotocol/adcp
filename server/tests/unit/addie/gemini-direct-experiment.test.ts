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

import { AddieClaudeClient, type AddieResponse, type ProcessMessageOptions, type StreamEvent } from '../../../src/addie/claude-client.js';
import { GoogleGenerateContentProvider, GOOGLE_ROUTER_MODEL } from '../../../src/addie/model-providers/google-generate-content-provider.js';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import { createGeminiDirectTools } from '../../../src/addie/gemini-direct-tools.js';
import { geminiDirectAssignment, prepareGeminiDirectTurn } from '../../../src/addie/gemini-direct-experiment.js';
import { AddieModelConfig } from '../../../src/config/models.js';

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

function fixture(responses: GenerateContentResponse[]) {
  const dispatch = vi.fn(async function* (_payload: GenerateContentParameters) {
    const next = responses.shift();
    if (!next) throw new Error('No response');
    yield next;
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
    exclusionReason: null, startedAt: Date.now(), requestTools: { tools: [], handlers: new Map() },
    baseRequestContext: 'Trusted member context.', getControlTools,
  };
  return { client, fork, provider, dispatch, handlers, control, input, getControlTools };
}

async function run(input: Parameters<typeof prepareGeminiDirectTurn>[0]) {
  const turn = await prepareGeminiDirectTurn(input);
  const events: StreamEvent[] = [];
  for await (const event of turn.client.processMessageStream('Help with AdCP.', [], turn.selection?.requestTools, {
    ...options, allowedToolNames: turn.selection?.allowedToolNames, selectedToolSetNames: turn.selection?.selectedToolSets,
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

  it('loads authorized domains on demand and keeps writes out of every invocation', async () => {
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

  it('blocks a model calling an unloaded tool even when its handler exists', async () => {
    const f = fixture([receipt([call('get_recent_news')]), receipt([{ text: 'No news lookup was performed.' }], 'answer')]);
    const result = await run(f.input);
    expect(f.handlers.get('get_recent_news')).not.toHaveBeenCalled();
    expect(result.response?.tool_executions[0]).toMatchObject({ blocked_by_policy: true, is_error: true });
  });

  it('hands unsupported work to control, charges the Gemini step, and retains treatment attribution', async () => {
    const f = fixture([receipt([call('handoff_to_addie')])]);
    const result = await run(f.input);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.getControlTools).toHaveBeenCalledOnce();
    expect(f.control).toHaveBeenCalledOnce();
    expect(result.response?.model_execution).toMatchObject({ requested_provider: 'google', provider: 'anthropic', model_resolution: 'fallback', fallback_reason: 'primary_capability_unsupported' });
    expect(mocks.recordCost).toHaveBeenCalledOnce();
    expect(f.control.mock.calls[0][3]).toMatchObject({ modelOverride: undefined, directToolSession: undefined, allowedToolNames: ['search_docs'] });
    const outcome = mocks.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE addie_chat_experiment_turns')).at(-1)?.[1];
    expect(outcome[7]).toBe('capability_handoff');
    expect(JSON.parse(outcome[12]).map((event: { provider: string }) => event.provider)).toEqual(['google', 'anthropic']);
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

  it.each(['attachments', 'certification', 'interrupted_turn_retry', 'github_mutation'])('keeps excluded %s turns on control', async exclusionReason => {
    const f = fixture([]);
    await run({ ...f.input, exclusionReason });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control).toHaveBeenCalledOnce();
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
    expect(direct.allowedToolNames).toEqual(['search_docs', 'load_tool_group', 'handoff_to_addie']);
  });
});

describe('native Google streaming', () => {
  it('combines streamed text, preserves signed empty parts, and uses final usage', async () => {
    const progress = vi.fn();
    const provider = new GoogleGenerateContentProvider('unused', { models: {
      generateContent: vi.fn(),
      generateContentStream: async () => (async function* () {
        yield { responseId: 'stream', modelVersion: GOOGLE_ROUTER_MODEL, candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] } as GenerateContentResponse;
        yield receipt([{ text: '', thoughtSignature: 'signed-empty' }], 'stream');
      })(),
    } });
    const response = await collectModelResponse(provider.respond({ model: GOOGLE_ROUTER_MODEL, system: [], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], maxOutputTokens: 100 }, { stream: true, onStreamProgress: progress }));
    expect(response.content).toEqual([{ type: 'text', text: 'Hello' }, { type: 'text', text: '' }]);
    expect(response.usage.outputTokens).toBe(15);
    expect(progress).toHaveBeenCalledTimes(2);
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

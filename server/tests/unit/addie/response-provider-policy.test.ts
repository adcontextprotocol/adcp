import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';

const mocks = vi.hoisted(() => ({ recordCost: vi.fn(), checkCostCap: vi.fn(), log: vi.fn() }));
vi.mock('../../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));
vi.mock('../../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn(), notifyToolError: vi.fn() }));
vi.mock('../../../src/logger.js', () => ({ createLogger: () => ({ info: mocks.log, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/addie/config-version.js', () => ({ getCurrentConfigVersionId: vi.fn().mockResolvedValue(123) }));
vi.mock('../../../src/addie/rules/index.js', () => ({
  loadCoreRules: () => 'You are Addie.', loadScopedRules: () => '',
  loadConstraintRules: () => 'Use tools honestly.', loadResponseStyle: () => 'Answer clearly.', invalidateRulesCache: vi.fn(),
}));
vi.mock('../../../src/addie/claude-cost-tracker.js', () => ({
  recordCost: mocks.recordCost, checkCostCap: mocks.checkCostCap,
  releaseCertificationReserve: vi.fn(), renewCertificationReserve: vi.fn(), formatCapExceededMessage: () => 'Daily cap reached.',
}));

import { AddieClaudeClient, type AddieResponse, type ProcessMessageOptions, type StreamEvent } from '../../../src/addie/claude-client.js';
import { GoogleGenerateContentProvider, GOOGLE_ROUTER_MODEL } from '../../../src/addie/model-providers/google-generate-content-provider.js';
import { ProviderHealthController } from '../../../src/addie/model-providers/provider-health.js';
import { responseClient } from '../../../src/addie/response-client.js';
import { getResponseProviderPolicy } from '../../../src/addie/response-provider-policy.js';
import { AddieModelConfig } from '../../../src/config/models.js';

const answer: AddieResponse = {
  text: 'Verified answer.', tools_used: [], tool_executions: [],
  model_execution: { source: 'provider', requested_provider: 'anthropic', requested_model: AddieModelConfig.chat,
    provider: 'anthropic', model: AddieModelConfig.chat, model_resolution: 'exact', fallback_reason: null },
};
function receipt(name?: string): GenerateContentResponse {
  return { responseId: 'google-response', modelVersion: GOOGLE_ROUTER_MODEL,
    candidates: [{ content: { role: 'model', parts: name
      ? [{ functionCall: { id: 'call-1', name, args: {} }, thoughtSignature: 'signature' }]
      : [{ text: 'Verified answer.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
  } as GenerateContentResponse;
}
function fixture(responses: Array<GenerateContentResponse | Error> = [receipt()]) {
  const health = new ProviderHealthController({ failureThreshold: 1 });
  const dispatch = vi.fn(async () => {
    const response = responses.shift();
    if (!response || response instanceof Error) throw response ?? new Error('No response');
    return response;
  });
  const provider = new GoogleGenerateContentProvider('unused', { models: {
    generateContent: dispatch,
    generateContentStream: async () => (async function* () { yield await dispatch(); })(),
  } });
  const client = new AddieClaudeClient('unused', AddieModelConfig.chat, health);
  const read = vi.fn().mockResolvedValue('Verified documentation.');
  const action = vi.fn().mockResolvedValue('Action completed.');
  for (const [name, handler] of [['search_docs', read], ['send_invoice', action]] as const) {
    client.registerTool({ name, description: name, input_schema: { type: 'object', properties: {} } }, handler);
  }
  const fork = client.forkForGeminiDirect(provider);
  vi.spyOn(client, 'forkForGeminiDirect').mockReturnValue(fork);
  const fallback = vi.spyOn(client, 'processMessage').mockResolvedValue(answer);
  const fallbackStream = vi.spyOn(client, 'processMessageStream').mockImplementation(async function* () {
    yield { type: 'text', text: answer.text }; yield { type: 'done', response: answer };
  });
  const options: ProcessMessageOptions = {
    allowedToolNames: ['search_docs', 'send_invoice'], selectedToolSetNames: ['knowledge'],
    modelOverride: 'specialist-must-not-select-response', maxIterations: 5,
    costScope: { userId: 'scoped-user', tier: 'anonymous' }, requestContext: 'Trusted context.',
    reserveSideEffect: vi.fn().mockResolvedValue(undefined),
  };
  return { client, fork, health, dispatch, fallback, fallbackStream, options, read, action };
}
async function collect(events: AsyncIterable<StreamEvent>) {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
beforeEach(() => {
  vi.stubEnv('ADDIE_RESPONSE_PROVIDER', 'gemini');
  vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'false');
  vi.stubEnv('GEMINI_API_KEY', 'unused');
  mocks.checkCostCap.mockReset().mockResolvedValue({ ok: true });
  mocks.recordCost.mockClear(); mocks.log.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('Global response provider policy', () => {
  it('defaults to Gemini with automatic fallback explicitly off and rejects ambiguous configuration', () => {
    expect(getResponseProviderPolicy({})).toEqual({ provider: 'gemini', automaticFallback: false });
    expect(() => getResponseProviderPolicy({ ADDIE_RESPONSE_PROVIDER: 'typo' })).toThrow('must be');
    expect(() => getResponseProviderPolicy({ ADDIE_RESPONSE_AUTOMATIC_FALLBACK: 'yes' })).toThrow('must be');
  });

  it.each(['web', 'slack', 'mcp', 'email', 'tavus'] as const)('%s uses the real Gemini loop and keeps scope, authority and provenance', async surface => {
    const f = fixture([receipt('search_docs'), receipt()]);
    const response = await responseClient(f.client, surface).processMessage('Find documentation', [], undefined, undefined, f.options);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.action).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
    expect(response.model_execution).toMatchObject({ provider: 'google', requested_model: GOOGLE_ROUTER_MODEL, model_resolution: 'exact' });
    expect(mocks.checkCostCap).toHaveBeenCalledWith('scoped-user', 'anonymous', expect.objectContaining({ selection: { provider: 'google', model: GOOGLE_ROUTER_MODEL } }));
    expect(mocks.recordCost).toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ surface, model_execution: response.model_execution }), expect.any(String));
  });

  it.each(['slack', 'tavus'] as const)('%s streaming yields receipts before continuation and retains Google provenance', async surface => {
    const f = fixture([receipt('search_docs'), receipt()]);
    const iterator = responseClient(f.client, surface).processMessageStream('Find documentation', [], undefined, f.options);
    let checkpointed = false;
    for await (const event of iterator) {
      if (event.type === 'tool_end') { expect(f.dispatch).toHaveBeenCalledTimes(1); checkpointed = true; }
      if (event.type === 'done') expect(event.response.model_execution).toMatchObject({ provider: 'google' });
    }
    expect(checkpointed).toBe(true);
  });

  it.each([false, true])('does not bypass the cost cap, even with fallback enabled=%s', async enabled => {
    vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', String(enabled));
    mocks.checkCostCap.mockResolvedValue({ ok: false, reason: 'cap_exceeded' });
    const f = fixture();
    const result = await responseClient(f.client, 'email').processMessage('Hello', [], undefined, undefined, f.options);
    expect(result.text).toBe('Daily cap reached.');
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
  });

  it.each(['missing_key', 'circuit_open'] as const)('fails closed for %s until automatic fallback is enabled', async failure => {
    const f = fixture();
    if (failure === 'missing_key') vi.stubEnv('GEMINI_API_KEY', '');
    else f.health.recordFailure('google', 'chat', { status: 503, message: 'Unavailable' });
    await expect(responseClient(f.client, 'mcp').processMessage('Hello', [], undefined, undefined, f.options)).rejects.toThrow('unavailable');
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
    vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'true');
    const result = await responseClient(f.client, 'mcp').processMessage('Hello', [], undefined, undefined, f.options);
    expect(result.model_execution).toMatchObject({ requested_provider: 'google', provider: 'anthropic', model_resolution: 'fallback', fallback_reason: 'primary_unavailable' });
    expect(f.fallback.mock.calls[0][4]).toMatchObject({ modelOverride: AddieModelConfig.chat, costScope: f.options.costScope, maxIterations: 5 });
  });

  it('opens the Google circuit across successive turns without opening Anthropic', async () => {
    const f = fixture([Object.assign(new Error('Unavailable'), { status: 503 })]);
    for (let turn = 0; turn < 2; turn++) {
      await expect(responseClient(f.client, 'slack').processMessage('Hello', [], undefined, undefined, f.options)).rejects.toThrow();
    }
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.health.acquire('anthropic', 'chat').allowed).toBe(true);
  });

  it.each(['stream', 'json'] as const)('falls back only before action reservation in %s delivery', async delivery => {
    vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'true');
    const f = fixture([receipt('search_docs'), new Error('Unavailable')]);
    const selected = responseClient(f.client, 'slack');
    const result = delivery === 'json'
      ? await selected.processMessage('Find documentation', [], undefined, undefined, f.options)
      : (await collect(selected.processMessageStream('Find documentation', [], undefined, f.options))).find(e => e.type === 'done')?.response;
    expect(f.read).toHaveBeenCalledOnce();
    expect(result?.model_execution).toMatchObject({ provider: 'anthropic', model_resolution: 'fallback' });
    expect(f.fallback.mock.calls.length + f.fallbackStream.mock.calls.length).toBe(1);
  });

  it.each([
    ['json', false], ['json', true], ['stream', false], ['stream', true],
  ] as const)('never replays after a reservation attempt (%s, reservation fails=%s)', async (delivery, reservationFails) => {
    vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'true');
    const f = fixture([receipt('send_invoice'), new Error('Unavailable')]);
    if (reservationFails) f.options.reserveSideEffect = vi.fn().mockRejectedValue(new Error('Ambiguous durable write'));
    const selected = responseClient(f.client, 'slack');
    if (delivery === 'json') {
      await expect(selected.processMessage('Send the invoice', [], undefined, undefined, f.options)).rejects.toThrow('reservation');
    } else {
      const events = await collect(selected.processMessageStream('Send the invoice', [], undefined, f.options));
      expect(events.at(-1)).toMatchObject({ type: 'stream_error', reason: expect.stringContaining('not automatically repeated') });
    }
    expect(f.options.reserveSideEffect).toHaveBeenCalledOnce();
    expect(f.action).toHaveBeenCalledTimes(reservationFails ? 0 : 1);
    expect(f.fallback).not.toHaveBeenCalled(); expect(f.fallbackStream).not.toHaveBeenCalled();
  });

  it('propagates checkpoint failure without continuation or fallback', async () => {
    vi.stubEnv('ADDIE_RESPONSE_AUTOMATIC_FALLBACK', 'true');
    const f = fixture([receipt('search_docs'), receipt()]);
    const iterator = responseClient(f.client, 'tavus').processMessageStream('Find documentation', [], undefined, f.options);
    while ((await iterator.next()).value?.type !== 'tool_end') { /* advance to checkpoint */ }
    await expect(iterator.throw(new Error('Checkpoint unavailable'))).rejects.toThrow('Checkpoint unavailable');
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.fallbackStream).not.toHaveBeenCalled();
  });

  it('keeps routed and replay-denied tools inaccessible on Gemini', async () => {
    const f = fixture([receipt('send_invoice'), receipt()]);
    await responseClient(f.client, 'tavus').processMessage('Hello', [], undefined, undefined, {
      ...f.options, toolExecutionPolicy: async () => ({ allowed: false }),
    });
    expect(f.action).not.toHaveBeenCalled(); expect(f.options.reserveSideEffect).not.toHaveBeenCalled();
  });

  it.each(['web', 'slack', 'mcp', 'email', 'tavus'] as const)('operator rollback routes %s to Sonnet even without Google credentials', async surface => {
    vi.stubEnv('ADDIE_RESPONSE_PROVIDER', 'sonnet'); vi.stubEnv('GEMINI_API_KEY', '');
    const f = fixture();
    const result = await responseClient(f.client, surface).processMessage('Hello', [], undefined, undefined, f.options);
    expect(result.model_execution).toMatchObject({ requested_provider: 'anthropic', model_resolution: 'exact' });
    expect(f.fallback.mock.calls[0][4]).toMatchObject({ modelOverride: AddieModelConfig.chat, costScope: f.options.costScope });
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.client.forkForGeminiDirect).not.toHaveBeenCalled();
  });
});

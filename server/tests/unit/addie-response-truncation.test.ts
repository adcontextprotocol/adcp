import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
  checkCostCap: vi.fn(),
  recordCost: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  APIError: class APIError extends Error {},
  APIConnectionError: class APIConnectionError extends Error {},
  default: class {
    beta = {
      messages: {
        create: async (payload: Record<string, unknown>, options?: unknown) => ({
          id: 'msg_test_nonstreaming',
          model: String(payload.model),
          ...await mocks.createMessage(payload, options),
        }),
        stream: (payload: Record<string, unknown>, options?: unknown) => {
          const stream = mocks.streamMessage(payload, options);
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            finalMessage: async () => ({
              id: 'msg_test_streaming',
              model: String(payload.model),
              ...await stream.finalMessage(),
            }),
          };
        },
      },
    };
  },
}));

vi.mock('../../src/addie/config-version.js', () => ({
  getCurrentConfigVersionId: vi.fn().mockResolvedValue(4431),
}));

vi.mock('../../src/addie/rules/index.js', () => ({
  loadRules: vi.fn(() => 'You are Addie.'),
  loadResponseStyle: vi.fn(() => 'Answer clearly.'),
  invalidateRulesCache: vi.fn(),
}));

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class {},
}));

vi.mock('../../src/addie/claude-cost-tracker.js', () => ({
  checkCostCap: mocks.checkCostCap,
  recordCost: mocks.recordCost,
  releaseCertificationReserve: vi.fn(),
  renewCertificationReserve: vi.fn(),
  formatCapExceededMessage: vi.fn(() => 'cap exceeded'),
}));

import { AddieClaudeClient, type StreamEvent } from '../../src/addie/claude-client.js';
import {
  MAX_OUTPUT_LENGTH,
  OUTPUT_TRUNCATION_SUFFIX,
  formatTruncatedOutput,
  validateOutput,
} from '../../src/addie/security.js';

type TruncationStopReason = 'max_tokens' | 'model_context_window_exceeded';
interface MockMessage {
  model: string;
  stop_reason: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details?: { thinking_tokens: number };
  };
}

const partialText = 'First complete sentence. This trailing sentence is unfinished';
const expectedTruncation = `First complete sentence.\n\n${OUTPUT_TRUNCATION_SUFFIX}`;

function message(
  stopReason: TruncationStopReason | 'end_turn' | 'pause_turn' | 'tool_use',
  text: string,
  usage = { input_tokens: 10, output_tokens: 20 },
): MockMessage {
  return {
    model: 'claude-sonnet-4-6-20260801',
    stop_reason: stopReason,
    content: text ? [{ type: 'text', text }] : [],
    usage,
  };
}

function providerToolTurn(): MockMessage {
  return {
    model: 'claude-sonnet-4-6-20260801',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'server_tool_use',
        id: 'server_web_4431',
        name: 'web_search',
        input: { query: 'AdCP' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'server_web_4431',
        content: [{ type: 'web_search_result', title: 'AdCP', url: 'https://adcontextprotocol.org' }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 5 },
  };
}

function mixedProviderAndCustomToolTurn(): MockMessage {
  return {
    model: 'claude-sonnet-4-6-20260801',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'server_tool_use',
        id: 'server_web_4431',
        name: 'web_search',
        input: { query: 'AdCP' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'server_web_4431',
        content: [{ type: 'web_search_result', title: 'AdCP', url: 'https://adcontextprotocol.org' }],
      },
      {
        type: 'tool_use',
        id: 'custom_lookup_4431',
        name: 'lookup',
        input: {},
      },
    ],
    usage: { input_tokens: 4, output_tokens: 5 },
  };
}

function streamFor(finalResponse: MockMessage, chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        };
      }
    },
    finalMessage: vi.fn().mockResolvedValue(finalResponse),
  };
}

describe('Addie response truncation (#4431)', () => {
  beforeEach(() => {
    mocks.createMessage.mockReset();
    mocks.streamMessage.mockReset();
    mocks.checkCostCap.mockReset().mockResolvedValue({ ok: true });
    mocks.recordCost.mockReset().mockResolvedValue(undefined);
  });

  it('applies the 10k cap at the last complete sentence with the canonical suffix', () => {
    const completeSentence = `${'A'.repeat(MAX_OUTPUT_LENGTH - 100)}.`;
    const unfinishedTail = ` ${'B'.repeat(250)}`;

    const result = validateOutput(completeSentence + unfinishedTail);

    expect(result.sanitized).toBe(`${completeSentence}\n\n${OUTPUT_TRUNCATION_SUFFIX}`);
    expect(result.sanitized).not.toContain('B');
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('Output truncated due to length');
  });

  it('returns only the continuation suffix when no token boundary is safe', () => {
    expect(formatTruncatedOutput('A'.repeat(MAX_OUTPUT_LENGTH + 1))).toBe(
      OUTPUT_TRUNCATION_SUFFIX,
    );
  });

  it.each([
    ['fenced code', 'Safe sentence.\n\n```ts\nconst value = broken. More'],
    ['tilde-fenced code', 'Safe sentence.\n\n~~~ts\nconst value = broken. More'],
    ['false backtick fence closer', 'Safe sentence.\n```ts\nsecret\n```not-a-close. More'],
    ['false tilde fence closer', 'Safe sentence.\n~~~ts\nsecret\n~~~not-a-close. More'],
    ['inline code', 'Safe sentence. `broken code sentence. More'],
    ['multi-backtick inline code', 'Safe sentence. ``broken ` code sentence. More'],
    ['Markdown link', 'Safe sentence. [link label](https://example.test/broken. More'],
    [
      'nested-parenthesis Markdown link',
      'Safe sentence. [link](https://example.test/a_(nested). Dangerous sentence. More',
    ],
  ])('retreats before unmatched %s', (_label, text) => {
    expect(formatTruncatedOutput(text)).toBe(expectedTruncation.replace('First complete', 'Safe'));
  });

  it('handles repeated unmatched Markdown constructs in a single safe scan', () => {
    const adversarial = `Safe sentence. ${
      '[label](https://example.test/a_(nested). '.repeat(500)
    }`;

    expect(formatTruncatedOutput(adversarial)).toBe(
      expectedTruncation.replace('First complete', 'Safe'),
    );
  });

  it('never splits combining marks or ZWJ emoji graphemes', () => {
    const combining = formatTruncatedOutput('e\u0301'.repeat(100), 50);
    const family = '👨‍👩‍👧‍👦';
    const zwj = formatTruncatedOutput(family.repeat(20), 50);

    expect(combining).toBe(OUTPUT_TRUNCATION_SUFFIX);
    expect(zwj).toBe(OUTPUT_TRUNCATION_SUFFIX);
    expect(combining).not.toContain('\uFFFD');
    expect(zwj).not.toContain('\u200D');
  });

  it.each<TruncationStopReason>([
    'max_tokens',
    'model_context_window_exceeded',
  ])('returns useful partial text once for non-streaming %s', async (stopReason) => {
    mocks.createMessage.mockResolvedValueOnce(message(stopReason, partialText));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const response = await client.processMessage(
      'Explain the protocol',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(expectedTruncation);
    expect(response.flag_reason).toBe(`Response truncated: ${stopReason}`);
    expect(response.model_execution).toEqual({
      source: 'provider',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260801',
      model_resolution: 'provider_canonicalized',
      fallback_reason: null,
    });
    expect(mocks.createMessage).toHaveBeenCalledOnce();
  });

  it.each<TruncationStopReason>([
    'max_tokens',
    'model_context_window_exceeded',
  ])('keeps streamed and final text identical for %s without resampling', async (stopReason) => {
    mocks.streamMessage.mockReturnValueOnce(streamFor(
      message(stopReason, partialText),
      ['First complete ', 'sentence. This trailing ', 'sentence is unfinished'],
    ));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Explain the protocol',
      undefined,
      undefined,
      { uncapped: true },
    )) {
      events.push(event);
    }

    const emittedText = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );

    expect(emittedText).toBe(expectedTruncation);
    expect(done?.response.text).toBe(emittedText);
    expect(done?.response.flag_reason).toBe(`Response truncated: ${stopReason}`);
    expect(done?.response.model_execution).toEqual({
      source: 'provider',
      requested_provider: 'anthropic',
      requested_model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260801',
      model_resolution: 'provider_canonicalized',
      fallback_reason: null,
    });
    expect(mocks.streamMessage).toHaveBeenCalledOnce();
  });

  it('postprocesses hostile truncated stream text before emitting it', async () => {
    const raw = "Great question. I'm Claude, an AI assistant made by Anthropic. Safe answer sentence. unfinished tail";
    mocks.streamMessage.mockReturnValueOnce(streamFor(message('max_tokens', raw), [raw]));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream('Explain this behavior', undefined, undefined, { uncapped: true })) {
      events.push(event);
    }

    const emitted = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(emitted).toBe(done?.response.text);
    expect(emitted).toContain('Safe answer sentence.');
    expect(emitted).toContain(OUTPUT_TRUNCATION_SUFFIX);
    expect(emitted).not.toMatch(/great question|claude|anthropic/i);
  });

  it('emits normal postprocessed text exactly once', async () => {
    const raw = 'Great question. AdCP standardizes workflows.';
    mocks.streamMessage.mockReturnValueOnce(streamFor(message('end_turn', raw), [raw]));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream('What does AdCP do?', undefined, undefined, { uncapped: true })) {
      events.push(event);
    }

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(textEvents).toEqual([{ type: 'text', text: 'AdCP standardizes workflows.' }]);
    expect(done?.response.text).toBe(textEvents[0].text);
  });

  it.each([
    ['complete', 'end_turn' as const, 'A complete provider answer.'],
    ['provider-truncated', 'max_tokens' as const, partialText],
  ])('keeps common %s terminal payload fields identical across delivery modes', async (_label, stopReason, rawText) => {
    const terminalMessage = message(stopReason, rawText, { input_tokens: 13, output_tokens: 21 });
    mocks.createMessage.mockResolvedValueOnce(terminalMessage);
    mocks.streamMessage.mockReturnValueOnce(streamFor(terminalMessage, [rawText]));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const nonStreaming = await client.processMessage(
      'Explain the protocol behavior',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );
    const streamEvents: StreamEvent[] = [];
    for await (const event of client.processMessageStream(
      'Explain the protocol behavior',
      undefined,
      undefined,
      { uncapped: true },
    )) streamEvents.push(event);
    const streaming = streamEvents.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    )?.response;

    const commonTerminalFields = (response: typeof nonStreaming) => ({
      text: response.text,
      tools_used: response.tools_used,
      tool_executions: response.tool_executions,
      flagged: response.flagged,
      flag_reason: response.flag_reason,
      active_rule_ids: response.active_rule_ids,
      config_version_id: response.config_version_id,
      model_execution: response.model_execution,
      usage: response.usage,
    });
    expect(streaming).toBeDefined();
    expect(commonTerminalFields(streaming!)).toEqual(commonTerminalFields(nonStreaming));
  });

  it('does not treat an under-10k alphanumeric ending as a truncation sentinel', async () => {
    const completeText = 'A complete sentence. A final sentence without punctuation';
    mocks.streamMessage.mockReturnValueOnce(streamFor(
      message('end_turn', completeText),
      ['A complete sentence. A final ', 'sentence without punctuation'],
    ));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Explain the protocol',
      undefined,
      undefined,
      { uncapped: true },
    )) {
      events.push(event);
    }

    const emittedText = events
      .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    const done = events.find(
      (event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done',
    );
    expect(emittedText).toBe(completeText);
    expect(done?.response.text).toBe(completeText);
    expect(done?.response.flagged).toBe(false);
    expect(done?.response.text).not.toContain(OUTPUT_TRUNCATION_SUFFIX);
  });

  it('applies the local 10k cap on a normal non-streaming completion', async () => {
    const sentence = `${'A'.repeat(MAX_OUTPUT_LENGTH - 100)}.`;
    const raw = `${sentence} ${'B'.repeat(250)}.`;
    mocks.createMessage.mockResolvedValueOnce(message('end_turn', raw));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const response = await client.processMessage(
      'Please provide a detailed and carefully structured explanation of this protocol behavior for our implementation review today',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe(`${sentence}\n\n${OUTPUT_TRUNCATION_SUFFIX}`);
    expect(response.text.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(response.flag_reason).toBe('Output truncated due to length');
    expect(mocks.createMessage).toHaveBeenCalledOnce();
  });

  it('applies the local 10k cap before normal streaming delivery', async () => {
    const sentence = `${'A'.repeat(MAX_OUTPUT_LENGTH - 100)}.`;
    const raw = `${sentence} ${'B'.repeat(250)}.`;
    mocks.streamMessage.mockReturnValueOnce(streamFor(message('end_turn', raw), [raw]));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Please provide a detailed and carefully structured explanation of this protocol behavior for our implementation review today',
      undefined,
      undefined,
      { uncapped: true },
    )) {
      events.push(event);
    }

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(textEvents).toEqual([{ type: 'text', text: `${sentence}\n\n${OUTPUT_TRUNCATION_SUFFIX}` }]);
    expect(done?.response.text).toBe(textEvents[0].text);
    expect(textEvents[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(done?.response.flag_reason).toBe('Output truncated due to length');
  });

  it('keeps tool-transition separators inside the cap without duplication or retry', async () => {
    const firstSentence = `${'A'.repeat(MAX_OUTPUT_LENGTH - 50)}.`;
    const toolTurn: MockMessage = {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: firstSentence },
        { type: 'tool_use', id: 'toolu_4431', name: 'lookup', input: {} },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    };
    const finalText = `${'B'.repeat(100)}.`;
    mocks.streamMessage
      .mockReturnValueOnce(streamFor(toolTurn, [firstSentence]))
      .mockReturnValueOnce(streamFor(message('end_turn', finalText), [finalText]));
    const lookup = vi.fn().mockResolvedValue('ok');
    const requestTools = {
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' as const, properties: {} } }],
      handlers: new Map([['lookup', lookup]]),
    };
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Please provide a detailed and carefully structured explanation of this protocol behavior for our implementation review today',
      undefined,
      requestTools,
      { uncapped: true },
    )) {
      events.push(event);
    }

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toBe(done?.response.text);
    expect(textEvents[0].text).toBe(`${firstSentence}\n\n${OUTPUT_TRUNCATION_SUFFIX}`);
    expect(textEvents[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(lookup).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('does not resample after a late custom tool when the terminal turn hits max_tokens', async () => {
    const toolTurn: MockMessage = {
      model: 'claude-sonnet-5-20260801',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_late', name: 'lookup', input: {} }],
      usage: { input_tokens: 4, output_tokens: 5 },
    };
    const truncated = message('max_tokens', partialText, {
      input_tokens: 6,
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 6 },
    });
    mocks.streamMessage
      .mockReturnValueOnce(streamFor(toolTurn, []))
      .mockReturnValueOnce(streamFor(truncated, [partialText]));
    const lookup = vi.fn().mockResolvedValue('ok');
    const requestTools = {
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' as const, properties: {} } }],
      handlers: new Map([['lookup', lookup]]),
    };
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-5');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Run the lookup and explain the result',
      undefined,
      requestTools,
      { uncapped: true },
    )) events.push(event);

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.flag_reason).toBe('Response truncated: max_tokens');
    expect(done?.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 12 });
    expect(lookup).toHaveBeenCalledOnce();
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('continues pause_turn from the provider response instead of repeating the original prompt', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(message('pause_turn', 'Server work is pending.'))
      .mockResolvedValueOnce(message('end_turn', 'Server work finished.'));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const response = await client.processMessage(
      'Run the server work',
      undefined,
      undefined,
      undefined,
      { uncapped: true },
    );

    expect(response.text).toBe('Server work finished.');
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createMessage.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Server work is pending.' }],
      }),
    ]));
  });

  it('suppresses streaming pause_turn text and emits only the terminal answer', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(streamFor(message('pause_turn', 'Interim server status.'), ['Interim server status.']))
      .mockReturnValueOnce(streamFor(message('end_turn', 'Terminal answer.'), ['Terminal answer.']));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream('Run the server work', undefined, undefined, { uncapped: true })) {
      events.push(event);
    }

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(textEvents).toEqual([{ type: 'text', text: 'Terminal answer.' }]);
    expect(done?.response.text).toBe('Terminal answer.');
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'Interim server status.' }] }),
    ]));
  });

  it('continues a streaming provider-managed tool turn before delivering the terminal answer', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(streamFor(providerToolTurn(), []))
      .mockReturnValueOnce(streamFor(message('end_turn', 'Search complete.'), ['Search complete.']));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Search for AdCP',
      undefined,
      undefined,
      { uncapped: true },
    )) events.push(event);

    const textEvents = events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text');
    const toolEvents = events.filter((event) => event.type === 'tool_start' || event.type === 'tool_end');
    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(textEvents).toEqual([{ type: 'text', text: 'Search complete.' }]);
    expect(toolEvents).toEqual([
      { type: 'tool_start', tool_name: 'web_search', parameters: { query: 'AdCP' } },
      expect.objectContaining({ type: 'tool_end', tool_name: 'web_search', is_error: false }),
    ]);
    expect(done?.response.text).toBe('Search complete.');
    expect(done?.response.tools_used).toEqual(['web_search']);
    expect(done?.response.tool_executions).toHaveLength(1);
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([expect.objectContaining({ type: 'server_tool_use' })]),
      }),
    ]));
  });

  it('records a provider result exactly once on a mixed custom-tool turn', async () => {
    mocks.createMessage
      .mockResolvedValueOnce(mixedProviderAndCustomToolTurn())
      .mockResolvedValueOnce(message('end_turn', 'Both lookups completed.'));
    const lookup = vi.fn().mockResolvedValue('Custom lookup completed.');
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');

    const response = await client.processMessage(
      'Run both lookups',
      undefined,
      {
        tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
        handlers: new Map([['lookup', lookup]]),
      },
      undefined,
      { uncapped: true },
    );

    expect(lookup).toHaveBeenCalledOnce();
    expect(response.tools_used).toEqual(['web_search', 'lookup']);
    expect(response.tool_executions).toHaveLength(2);
    expect(response.tool_executions.map((execution) => ({
      tool: execution.tool_name,
      sequence: execution.sequence,
    }))).toEqual([
      { tool: 'web_search', sequence: 1 },
      { tool: 'lookup', sequence: 2 },
    ]);
  });

  it('charges accumulated truncation usage exactly once', async () => {
    mocks.streamMessage
      .mockReturnValueOnce(streamFor(
        message('pause_turn', 'Interim status.', { input_tokens: 3, output_tokens: 4 }),
        ['Interim status.'],
      ))
      .mockReturnValueOnce(streamFor(
        message('max_tokens', partialText, { input_tokens: 5, output_tokens: 6 }),
        [partialText],
      ));
    const client = new AddieClaudeClient('sk-fake-unused', 'claude-sonnet-4-6');
    const events: StreamEvent[] = [];

    for await (const event of client.processMessageStream(
      'Explain the protocol',
      undefined,
      undefined,
      { costScope: { userId: 'user-4431', tier: 'member_paid' } },
    )) {
      events.push(event);
    }

    const done = events.find((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done');
    expect(done?.response.usage).toMatchObject({ input_tokens: 8, output_tokens: 10 });
    expect(mocks.recordCost).toHaveBeenCalledOnce();
    expect(mocks.recordCost).toHaveBeenCalledWith(
      'user-4431',
      'claude-sonnet-5',
      expect.objectContaining({ input_tokens: 8, output_tokens: 10 }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createSlackDmStreamState,
  interpretSlackDmStreamEvent,
  planSlackDmTerminalDelivery,
  reduceSlackDmStreamEvent,
  resolveSlackDmStreamSoftCap,
  shouldStopSlackDmStream,
  type SlackDmStreamConfig,
  type SlackDmStreamInterpreter,
  type SlackDmStreamState,
} from '../../../src/addie/slack-dm-stream.js';
import type { StreamEvent } from '../../../src/addie/claude-client.js';

const CONFIG: SlackDmStreamConfig = {
  softCap: 10,
  continuationTail: '<continued>',
};

describe('resolveSlackDmStreamSoftCap', () => {
  it.each([
    { raw: undefined, value: 9000, invalid: false },
    { raw: '', value: 9000, invalid: false },
    { raw: '1000', value: 1000, invalid: false },
    { raw: '11000', value: 11000, invalid: false },
    { raw: '999', value: 9000, invalid: true },
    { raw: '11001', value: 9000, invalid: true },
    { raw: 'nope', value: 9000, invalid: true },
    { raw: '9000abc', value: 9000, invalid: false },
  ])('resolves $raw to $value (invalid=$invalid)', ({ raw, value, invalid }) => {
    expect(resolveSlackDmStreamSoftCap(raw)).toEqual({ value, invalid });
  });
});

function makeIo(options: { failStop?: boolean; failAppendAt?: number; failSay?: boolean } = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  let appendCount = 0;
  const io: SlackDmStreamInterpreter = {
    append: vi.fn(async payload => {
      appendCount++;
      calls.push({ kind: 'append', value: payload });
      if (options.failAppendAt === appendCount) throw new Error(`append ${appendCount} failed`);
    }),
    stop: vi.fn(async () => {
      calls.push({ kind: 'stop' });
      if (options.failStop) throw new Error('stop failed');
    }),
    say: vi.fn(async message => {
      calls.push({ kind: 'say', value: message });
      if (options.failSay) throw new Error('say failed');
    }),
    setStatus: vi.fn(async status => {
      calls.push({ kind: 'status', value: status });
    }),
    log: vi.fn((level, fields, message) => {
      calls.push({ kind: `log:${level}`, value: { fields, message } });
    }),
  };
  return { io, calls };
}

function streamError(reason = 'overloaded_error'): StreamEvent {
  return {
    type: 'stream_error',
    reason,
    deltasBeforeError: 2,
    tool_executions: [],
    certification_reserve_used: false,
  };
}

async function hitCap(io: SlackDmStreamInterpreter): Promise<SlackDmStreamState> {
  return interpretSlackDmStreamEvent(
    createSlackDmStreamState(),
    { type: 'text', text: 'abcdefghijklmno' },
    CONFIG,
    io,
  );
}

describe('Slack DM stream degenerate paths', () => {
  it('finalizes at the length cap and carries the remainder after stop succeeds', async () => {
    const { io, calls } = makeIo();
    const state = await hitCap(io);

    expect(state.delivery).toEqual({ tag: 'cap_finalized', streamedLen: 10 });
    expect(state.continuationBuffer).toBe('klmno');
    expect(state.fullText).toBe('abcdefghijklmno');
    expect(planSlackDmTerminalDelivery(state)).toBe('continuation');
    expect(calls.map(call => call.kind)).toEqual(['append', 'log:info', 'append', 'stop']);
    expect(calls[0].value).toEqual({ markdown_text: 'abcdefghij' });
    expect(calls[2].value).toEqual({ markdown_text: '<continued>' });
  });

  it('marks delivery uncertain when the cap stop fails', async () => {
    const { io, calls } = makeIo({ failStop: true });
    const state = await hitCap(io);

    expect(state.delivery).toEqual({ tag: 'closed_uncertain', streamedLen: 10, reason: 'length_cap' });
    expect(state.continuationBuffer).toBe('');
    expect(planSlackDmTerminalDelivery(state)).toBe('delivery-notice');
    expect(calls.map(call => call.kind)).toEqual(['append', 'log:info', 'append', 'stop', 'log:warn']);
    expect(calls.at(-1)?.value).toMatchObject({
      message: 'Addie Bolt: Stream stop at length cap failed — falling through to post-loop fallback',
    });
  });

  it('renders inline recovery and stops when stream_error arrives before the cap', async () => {
    const { io, calls } = makeIo();
    let state = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'abc' },
      CONFIG,
      io,
    );
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(state.delivery).toEqual({ tag: 'closed_uncertain', streamedLen: 3, reason: 'interrupted' });
    expect(state.streamWasInterrupted).toBe(true);
    expect(state.streamInterruptCategory).toBe('overloaded');
    expect(planSlackDmTerminalDelivery(state)).toBe('none');
    expect(calls.map(call => call.kind)).toEqual(['append', 'log:warn', 'append', 'stop']);
  });

  it('keeps the finalized continuation and posts recovery before post-loop continuation on late stream_error', async () => {
    const { io, calls } = makeIo();
    let state = await hitCap(io);
    state = await interpretSlackDmStreamEvent(state, { type: 'text', text: 'pqr' }, CONFIG, io);
    state = await interpretSlackDmStreamEvent(state, streamError('api_error'), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(state.delivery).toEqual({ tag: 'cap_finalized', streamedLen: 10 });
    expect(state.continuationBuffer).toBe('klmnopqr');
    expect(state.streamWasInterrupted).toBe(true);
    expect(planSlackDmTerminalDelivery(state)).toBe('continuation');
    // The first message is already sealed by stop; the recovery follow-up is
    // sent here, and bolt-app's unchanged post-loop path posts continuation third.
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:info', 'append', 'stop', 'log:warn', 'say',
    ]);
  });

  it('posts follow-up recovery after a cap stop failure without retrying the stream', async () => {
    const { io, calls } = makeIo({ failStop: true });
    let state = await hitCap(io);
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(state.delivery).toEqual({ tag: 'closed_uncertain', streamedLen: 10, reason: 'length_cap' });
    expect(planSlackDmTerminalDelivery(state)).toBe('none');
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:info', 'append', 'stop', 'log:warn', 'log:warn', 'say',
    ]);
  });

  it('keeps streamedLen at zero when the cap-prefix append and stop both fail', async () => {
    const { io, calls } = makeIo({ failAppendAt: 1, failStop: true });
    const state = await hitCap(io);

    expect(state.delivery).toEqual({ tag: 'closed_uncertain', streamedLen: 0, reason: 'length_cap' });
    expect(planSlackDmTerminalDelivery(state)).toBe('full-response');
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:warn', 'log:info', 'append', 'stop', 'log:warn',
    ]);
    expect(calls[1].value).toMatchObject({
      message: 'Addie Bolt: Stream append failed for chunk, continuing',
    });
  });

  it('logs a tail append failure before stopping with the successful prefix length', async () => {
    const { io, calls } = makeIo({ failAppendAt: 2 });
    const state = await hitCap(io);

    expect(state.delivery).toEqual({ tag: 'cap_finalized', streamedLen: 10 });
    expect(planSlackDmTerminalDelivery(state)).toBe('continuation');
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:info', 'append', 'log:warn', 'stop',
    ]);
    expect(calls[3].value).toMatchObject({
      message: 'Addie Bolt: Continuation tail marker append failed',
    });
  });

  it('logs recovery append failure before stop and remains terminal', async () => {
    const { io, calls } = makeIo({ failAppendAt: 2 });
    let state = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'abc' },
      CONFIG,
      io,
    );
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:warn', 'append', 'log:warn', 'stop',
    ]);
    expect(calls[3].value).toMatchObject({ message: 'Addie Bolt: Recovery banner append failed' });
  });

  it('logs recovery stop failure after the inline banner and remains terminal', async () => {
    const { io, calls } = makeIo({ failStop: true });
    let state = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'abc' },
      CONFIG,
      io,
    );
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:warn', 'append', 'stop', 'log:warn',
    ]);
    expect(calls[4].value).toMatchObject({ message: 'Addie Bolt: Streamer stop after interruption failed' });
  });

  it('logs a post-close recovery say failure after the recovery attempt', async () => {
    const { io, calls } = makeIo({ failSay: true });
    let state = await hitCap(io);
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(state.phase).toEqual({ tag: 'terminal' });
    expect(calls.map(call => call.kind)).toEqual([
      'append', 'log:info', 'append', 'stop', 'log:warn', 'say', 'log:warn',
    ]);
    expect(calls[6].value).toMatchObject({
      message: 'Addie Bolt: Recovery banner say() failed after stream close',
    });
  });
});

describe('reduceSlackDmStreamEvent reachable state table', () => {
  const response = {
    text: 'done', tools_used: [], tool_executions: [], flagged: false,
  };

  it('routes text exactly from open, finalized, and uncertain traced states', async () => {
    const openIo = makeIo();
    const open = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'ab' },
      CONFIG,
      openIo.io,
    );
    const finalized = await hitCap(makeIo().io);
    const uncertain = await hitCap(makeIo({ failStop: true }).io);

    const openText = reduceSlackDmStreamEvent(open, { type: 'text', text: 'xy' }, CONFIG);
    expect(openText.state).toMatchObject({
      phase: { tag: 'awaiting_effect' },
      delivery: { tag: 'open', streamedLen: 2 },
      fullText: 'abxy',
    });
    expect(openText.effects).toMatchObject([
      { kind: 'stream_append', effectId: 'stream_effect_2', payload: { markdown_text: 'xy' } },
    ]);

    const finalizedText = reduceSlackDmStreamEvent(finalized, { type: 'text', text: 'xy' }, CONFIG);
    expect(finalizedText.effects).toEqual([]);
    expect(finalizedText.state).toMatchObject({
      delivery: { tag: 'cap_finalized', streamedLen: 10 },
      fullText: 'abcdefghijklmnoxy',
      continuationBuffer: 'klmnoxy',
    });

    const uncertainText = reduceSlackDmStreamEvent(uncertain, { type: 'text', text: 'xy' }, CONFIG);
    expect(uncertainText.effects).toEqual([]);
    expect(uncertainText.state).toMatchObject({
      delivery: { tag: 'closed_uncertain', streamedLen: 10, reason: 'length_cap' },
      fullText: 'abcdefghijklmnoxy',
      continuationBuffer: '',
    });
  });

  it('orders key effects from coherent open and closed traces', async () => {
    const open = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'ab' },
      CONFIG,
      makeIo().io,
    );
    const finalized = await hitCap(makeIo().io);

    const startOpen = reduceSlackDmStreamEvent(open, {
      type: 'tool_start', tool_name: 'lookup', parameters: {},
    }, CONFIG);
    expect(startOpen.effects).toMatchObject([{
      kind: 'stream_append',
      payload: { chunks: [
        { type: 'plan_update' },
        { type: 'task_update', id: 'lookup_1', status: 'in_progress' },
      ] },
    }]);

    const startClosed = reduceSlackDmStreamEvent(finalized, {
      type: 'tool_start', tool_name: 'lookup', parameters: {},
    }, CONFIG);
    expect(startClosed.effects).toEqual([]);
    expect(startClosed.state.toolsUsed).toEqual(['lookup']);

    const retry = reduceSlackDmStreamEvent(open, {
      type: 'retry', attempt: 2, maxRetries: 3, delayMs: 5, reason: 'Busy',
    }, CONFIG);
    expect(retry.effects).toMatchObject([
      { kind: 'set_status', effectId: 'stream_effect_2', status: 'Busy, retrying (2/3)...' },
    ]);

    const openError = reduceSlackDmStreamEvent(open, streamError(), CONFIG);
    expect(openError.effects.map(effect => effect.kind)).toEqual(['log', 'stream_append']);
    const closedError = reduceSlackDmStreamEvent(finalized, streamError(), CONFIG);
    expect(closedError.effects.map(effect => effect.kind)).toEqual(['log', 'say']);

    const done = reduceSlackDmStreamEvent(open, { type: 'done', response }, CONFIG);
    expect(done.state.response).toBe(response);
    expect(done.effects).toEqual([]);

    const error = reduceSlackDmStreamEvent(open, { type: 'error', error: 'boom' }, CONFIG);
    expect(error.effects).toEqual([{ kind: 'throw_error', error: 'boom' }]);
  });

  it('marks interruption terminal so Bolt breaks before accepting another provider event', async () => {
    const { io } = makeIo();
    let state = await interpretSlackDmStreamEvent(
      createSlackDmStreamState(),
      { type: 'text', text: 'abc' },
      CONFIG,
      io,
    );
    state = await interpretSlackDmStreamEvent(state, streamError(), CONFIG, io);

    expect(shouldStopSlackDmStream(state)).toBe(true);
    const later = reduceSlackDmStreamEvent(state, { type: 'text', text: 'must-not-append' }, CONFIG);
    expect(later.state).toBe(state);
    expect(later.effects).toEqual([{
      kind: 'log',
      level: 'warn',
      fields: { eventType: 'text', phase: 'terminal' },
      message: 'Addie Bolt: Ignoring stream event while an effect is pending',
    }]);
  });
});

describe('Slack DM stream tool metadata', () => {
  it('uses unique task ids, sends the plan title once, and records tool completion', async () => {
    const { io, calls } = makeIo({ failAppendAt: 1 });
    let state = createSlackDmStreamState();
    state = await interpretSlackDmStreamEvent(state, {
      type: 'tool_start', tool_name: 'lookup', parameters: { query: 'first' },
    }, CONFIG, io);
    state = await interpretSlackDmStreamEvent(state, {
      type: 'tool_start', tool_name: 'lookup', parameters: { query: 'second' },
    }, CONFIG, io);
    state = await interpretSlackDmStreamEvent(state, {
      type: 'tool_end', tool_name: 'lookup', result: 'ok', is_error: false,
    }, CONFIG, io);

    expect(state.toolsUsed).toEqual(['lookup', 'lookup']);
    expect(state.activeToolTaskIds).toEqual(['lookup_1']);
    expect(state.toolExecutions).toEqual([{ tool_name: 'lookup', parameters: {}, result: 'ok' }]);
    const appendPayloads = calls.filter(call => call.kind === 'append').map(call => call.value);
    expect(appendPayloads[0]).toMatchObject({ chunks: [
      { type: 'plan_update', title: 'Addie is working' },
      { type: 'task_update', id: 'lookup_1', status: 'in_progress' },
    ] });
    expect(appendPayloads[1]).toMatchObject({ chunks: [
      { type: 'task_update', id: 'lookup_2', status: 'in_progress' },
    ] });
    expect(appendPayloads[2]).toMatchObject({ chunks: [
      { type: 'task_update', id: 'lookup_2', status: 'complete', output: 'Tool completed: lookup' },
    ] });
  });

  it('keeps tool metadata but suppresses widgets after a traced stream close', async () => {
    const initial = await hitCap(makeIo().io);
    const start = reduceSlackDmStreamEvent(initial, {
      type: 'tool_start', tool_name: 'late_tool', parameters: {},
    }, CONFIG);
    const end = reduceSlackDmStreamEvent(start.state, {
      type: 'tool_end', tool_name: 'late_tool', result: 'late result', is_error: true,
    }, CONFIG);

    expect(start.effects).toEqual([]);
    expect(end.effects).toEqual([]);
    expect(end.state.toolsUsed).toEqual(['late_tool']);
    expect(end.state.toolExecutions).toEqual([
      { tool_name: 'late_tool', parameters: {}, result: 'late result' },
    ]);
  });
});

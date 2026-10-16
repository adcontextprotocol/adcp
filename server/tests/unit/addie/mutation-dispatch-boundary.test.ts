import { describe, expect, it, vi } from 'vitest';
import { createAddieToolExecutor } from '../../../src/addie/model-providers/tool-orchestration.js';
import { blockCheckpointedToolReplays, buildToolResultCheckpoint, reserveToolIntentCheckpoint } from '../../../src/addie/stream-tool-checkpoints.js';
import type { AddieTool } from '../../../src/addie/types.js';

vi.mock('../../../src/addie/error-notifier.js', () => ({ notifyToolError: vi.fn() }));
const tool: AddieTool = {
  name: 'schedule_meeting', description: 'Schedule a meeting.', replaySafety: 'mutation',
  input_schema: { type: 'object', properties: {} },
};
const call = { type: 'tool_call' as const, id: 'call_1', name: tool.name, input: { title: 'Review' } };

describe('mutation dispatch authority boundary', () => {
  it.each(['schedule_meeting', 'call_adcp_task'])('fails closed without an authority callback for %s mutations', async name => {
    const mutation = { ...tool, name };
    const handler = vi.fn(); const reserve = vi.fn();
    const execute = createAddieToolExecutor([mutation], new Map([[name, handler]]), {
      executionMode: 'production', reserveSideEffect: reserve,
    });
    const result = await execute({ ...call, name, input: name === 'call_adcp_task'
      ? { task: 'create_media_buy', agent_url: 'https://seller.example', params: {} } : call.input }, 1);
    expect(result.execution).toMatchObject({ dispatch_status: 'not_dispatched', normalized_result: { status: 'recoverable_error' } });
    expect(result.execution.not_dispatched_reservation_id).toBeUndefined();
    expect(reserve).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

  it('checks authority around the awaited durable reservation before handler entry', async () => {
    const order: string[] = [];
    const execute = createAddieToolExecutor([tool], new Map([[tool.name, async () => {
      order.push('handler'); return 'Meeting scheduled';
    }]]), {
      executionMode: 'production',
      revalidateSideEffectAuthority: async ({ phase }) => { order.push(phase); return { allowed: true }; },
      reserveSideEffect: async () => { order.push('reserve'); return { reservationId: 'owned-intent' }; },
    });
    expect((await execute(call, 1)).execution.is_error).toBe(false);
    expect(order).toEqual(['before_reservation', 'reserve', 'after_reservation', 'handler']);
  });

  it.each(['before_reservation', 'after_reservation'] as const)('never dispatches on %s denial or outage, and permits a same-turn retry', async phase => {
    for (const status of ['access_denied', 'recoverable_error'] as const) {
      const handler = vi.fn().mockResolvedValue('Meeting scheduled');
      const reserve = vi.fn().mockResolvedValue({ reservationId: 'owned-intent' });
      let denied = true;
      const execute = createAddieToolExecutor([tool], new Map([[tool.name, handler]]), {
        executionMode: 'production', reserveSideEffect: reserve,
        revalidateSideEffectAuthority: async request => request.phase === phase && denied
          ? { allowed: false, status } : { allowed: true },
      });
      const result = await execute(call, 1);
      expect(result.execution).toMatchObject({ is_error: true, dispatch_status: 'not_dispatched', normalized_result: { status } });
      expect(result.execution.not_dispatched_reservation_id).toBe(phase === 'after_reservation' ? 'owned-intent' : undefined);
      expect(reserve).toHaveBeenCalledTimes(phase === 'after_reservation' ? 1 : 0);
      expect(handler).not.toHaveBeenCalled();
      denied = false;
      await execute({ ...call, id: 'retry' }, 2);
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed and retryably when authority checking throws', async () => {
    const handler = vi.fn();
    const reserve = vi.fn();
    const execute = createAddieToolExecutor([tool], new Map([[tool.name, handler]]), {
      executionMode: 'production', reserveSideEffect: reserve,
      revalidateSideEffectAuthority: async () => { throw new Error('authority storage unavailable'); },
    });
    expect((await execute(call, 1)).execution).toMatchObject({
      dispatch_status: 'not_dispatched', normalized_result: { status: 'recoverable_error' },
    });
    expect(reserve).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

  it('does not emit a settlement proof when reservation persistence rejects after a possible commit', async () => {
    const handler = vi.fn();
    const execute = createAddieToolExecutor([tool], new Map([[tool.name, handler]]), {
      executionMode: 'production',
      revalidateSideEffectAuthority: async () => ({ allowed: true }),
      reserveSideEffect: async () => { throw new Error('connection lost after COMMIT'); },
    });
    const result = await execute(call, 1);
    expect(result.execution.dispatch_status).toBeUndefined();
    expect(result.execution.not_dispatched_reservation_id).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    const checkpoint = buildToolResultCheckpoint({ threadId: 'thread', execution: result.execution, requestedModel: 'test' });
    const policy = blockCheckpointedToolReplays(checkpoint.tool_calls!);
    expect(await policy!({ toolName: call.name, toolCallId: call.id, input: call.input, executionMode: 'production' })).toEqual({ allowed: false });
  });

  it('serializes no-dispatch proof and allows restart retries without hiding older unknown calls', async () => {
    const execute = createAddieToolExecutor([tool], new Map([[tool.name, vi.fn()]]), {
      executionMode: 'production', reserveSideEffect: async () => ({ reservationId: 'owned-intent' }),
      revalidateSideEffectAuthority: async ({ phase }) => phase === 'before_reservation'
        ? { allowed: true } : { allowed: false, status: 'access_denied' },
    });
    const checkpoint = buildToolResultCheckpoint({ threadId: 'thread', execution: (await execute(call, 1)).execution, requestedModel: 'test' });
    expect(checkpoint.tool_calls![0]).toMatchObject({ dispatch_status: 'not_dispatched', not_dispatched_reservation_id: 'owned-intent' });
    expect(blockCheckpointedToolReplays(checkpoint.tool_calls!)).toBeUndefined();
    const unknown = { name: call.name, input: call.input, result: 'External action dispatch reserved; outcome unknown.', is_error: true };
    const policy = blockCheckpointedToolReplays([unknown, ...checkpoint.tool_calls!]);
    expect(await policy!({ toolName: call.name, toolCallId: call.id, input: call.input, executionMode: 'production' })).toEqual({ allowed: false });
  });

  it('returns the committed row identity instead of an inferred model call ID', async () => {
    const addMessage = vi.fn().mockResolvedValue({ message_id: 'committed-message' });
    expect(await reserveToolIntentCheckpoint({ addMessage }, {
      threadId: 'thread', toolName: call.name, parameters: call.input, requestedModel: 'test',
    })).toEqual({ reservationId: 'committed-message' });
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ mutation_reservation: { tool_name: call.name, input: call.input } }));
  });

  it('keeps read calls outside the mutation authority and reservation boundary', async () => {
    const readTool = { ...tool, name: 'lookup', replaySafety: 'principal_read' as const };
    const revalidate = vi.fn(); const reserve = vi.fn();
    const execute = createAddieToolExecutor([readTool], new Map([['lookup', async () => 'Found']]), {
      executionMode: 'production', revalidateSideEffectAuthority: revalidate, reserveSideEffect: reserve,
    });
    expect((await execute({ ...call, name: 'lookup' }, 1)).execution.is_error).toBe(false);
    expect(revalidate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
});

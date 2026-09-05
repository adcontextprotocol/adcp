import { describe, expect, it, vi } from 'vitest';
import {
  blockCheckpointedToolReplays,
  buildToolResultCheckpoint,
} from '../../../src/addie/stream-tool-checkpoints.js';

const execution = {
  tool_name: 'schedule_meeting',
  parameters: { title: 'Review', attendees: ['a@example.test'] },
  result: 'Meeting scheduled',
  is_error: false,
  duration_ms: 25,
  sequence: 1,
} as const;

describe('stream tool checkpoints', () => {
  it('stores one complete tool-use/result pair without partial assistant prose', () => {
    expect(buildToolResultCheckpoint({
      threadId: 'thread-1',
      execution,
      requestedModel: 'claude-sonnet-5',
      clientRequestId: 'request-1',
    })).toEqual({
      thread_id: 'thread-1',
      role: 'assistant',
      content: '',
      tools_used: ['schedule_meeting'],
      tool_calls: [{
        name: 'schedule_meeting',
        input: execution.parameters,
        result: 'Meeting scheduled',
        duration_ms: 25,
        is_error: false,
      }],
      model: 'claude-sonnet-5',
      model_execution: {
        source: 'local',
        requested_provider: 'anthropic',
        requested_model: 'claude-sonnet-5',
        reason: 'stream_interrupted',
      },
      client_request_id: 'request-1',
      delivery_status: 'interrupted',
    });
  });

  it('blocks only exact completed calls and preserves the existing policy', async () => {
    const delegate = vi.fn().mockReturnValue({ allowed: true });
    const policy = blockCheckpointedToolReplays([{
      name: 'schedule_meeting',
      input: { attendees: ['a@example.test'], title: 'Review' },
      result: 'Meeting scheduled',
    }], delegate)!;

    await expect(policy({
      toolName: 'schedule_meeting',
      input: { title: 'Review', attendees: ['a@example.test'] },
      executionMode: 'production',
    })).resolves.toEqual({ allowed: false });
    expect(delegate).not.toHaveBeenCalled();

    const changed = {
      toolName: 'schedule_meeting',
      input: { title: 'Different review', attendees: ['a@example.test'] },
      executionMode: 'production' as const,
    };
    await expect(policy(changed)).resolves.toEqual({ allowed: true });
    expect(delegate).toHaveBeenCalledWith(changed);
  });

  it('leaves failed checkpointed calls retryable through the existing policy', async () => {
    const delegate = vi.fn().mockReturnValue({ allowed: true });
    const policy = blockCheckpointedToolReplays([{
      name: 'schedule_meeting',
      input: execution.parameters,
      result: 'Calendar provider unavailable',
      is_error: true,
    }], delegate)!;
    const request = {
      toolName: 'schedule_meeting',
      input: execution.parameters,
      executionMode: 'production' as const,
    };

    expect(await policy(request)).toEqual({ allowed: true });
    expect(delegate).toHaveBeenCalledWith(request);
  });
});

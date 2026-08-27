import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelToolCallContent } from '../../../src/addie/model-providers/model-provider.js';
import {
  BLOCKED_TOOL_RESULT,
  createAddieToolExecutor,
} from '../../../src/addie/model-providers/tool-orchestration.js';
import type { AddieTool } from '../../../src/addie/types.js';

const notifyToolError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/addie/error-notifier.js', () => ({ notifyToolError }));

const tool: AddieTool = {
  name: 'lookup',
  description: 'Look up a value.',
  replaySafety: 'principal_read',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
};

function call(input: Record<string, unknown> = { id: 'abc' }): ModelToolCallContent {
  return { type: 'tool_call', id: 'call_1', name: 'lookup', input } as ModelToolCallContent;
}

describe('createAddieToolExecutor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes a validated call and returns a canonical provider-neutral result', async () => {
    const handler = vi.fn().mockResolvedValue('Found the requested value.');
    const policy = vi.fn().mockReturnValue({ allowed: true });
    const execute = createAddieToolExecutor([tool], new Map([['lookup', handler]]), {
      executionMode: 'production',
      policy,
    });

    const result = await execute(call(), 3);

    expect(policy).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'lookup',
      executionMode: 'production',
      tool: expect.objectContaining({ replaySafety: 'principal_read' }),
    }));
    expect(handler).toHaveBeenCalledWith({ id: 'abc' });
    expect(result.result).toEqual({
      type: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'lookup',
      content: 'Found the requested value.',
    });
    expect(result.execution).toMatchObject({
      tool_name: 'lookup',
      parameters: { id: 'abc' },
      result: 'Found the requested value.',
      is_error: false,
      sequence: 3,
    });
  });

  it('rejects structurally malformed provider input before policy or handler dispatch', async () => {
    const handler = vi.fn();
    const policy = vi.fn().mockReturnValue({ allowed: true });
    const execute = createAddieToolExecutor([tool], new Map([['lookup', handler]]), {
      executionMode: 'production',
      policy,
    });

    const result = await execute({
      type: 'tool_call', id: 'call_2', name: 'lookup', input: null,
    } as unknown as ModelToolCallContent, 2);

    expect(policy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ isError: true });
    expect(result.execution).toMatchObject({
      parameters: {},
      is_error: true,
      normalized_result: { status: 'invalid_input' },
    });
  });

  it('preserves handler-level coercion for recoverable schema drift', async () => {
    const tolerantTool: AddieTool = {
      ...tool,
      input_schema: {
        type: 'object',
        properties: { labels: { type: 'array', items: { type: 'string' } } },
        required: ['labels'],
      },
    };
    const handler = vi.fn(async (input: Record<string, unknown>) => {
      const labels = typeof input.labels === 'string'
        ? input.labels.split(',').map((label) => label.trim())
        : [];
      return `labels=${labels.join('|')}`;
    });
    const execute = createAddieToolExecutor(
      [tolerantTool],
      new Map([['lookup', handler]]),
      { executionMode: 'production', policy: () => ({ allowed: true }) },
    );

    const result = await execute(call({ labels: 'pricing, targeting' }), 1);

    expect(handler).toHaveBeenCalledWith({ labels: 'pricing, targeting' });
    expect(result.result).toMatchObject({ content: 'labels=pricing|targeting' });
    expect(result.execution).toMatchObject({ is_error: false });
  });

  it('takes immutable snapshots before the last-moment policy decision', async () => {
    const sourceInput = { id: 'original' };
    const handler = vi.fn().mockResolvedValue('ok');
    const policy = vi.fn((request: { input: Record<string, unknown> }) => {
      expect(() => { request.input.id = 'changed'; }).toThrow();
      return { allowed: true };
    });
    const execute = createAddieToolExecutor([tool], new Map([['lookup', handler]]), {
      executionMode: 'production',
      policy,
    });

    const pending = execute(call(sourceInput), 1);
    sourceInput.id = 'changed outside';
    const result = await pending;

    expect(handler).toHaveBeenCalledWith({ id: 'original' });
    expect(result.execution.parameters).toEqual({ id: 'original' });
  });

  it('fails closed in replay and redacts blocked inputs', async () => {
    const handler = vi.fn();
    const execute = createAddieToolExecutor([tool], new Map([['lookup', handler]]), {
      executionMode: 'replay',
    });

    const result = await execute(call({ id: 'secret' }), 1);

    expect(handler).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ content: BLOCKED_TOOL_RESULT, isError: true });
    expect(result.execution).toMatchObject({
      parameters: {},
      result: BLOCKED_TOOL_RESULT,
      blocked_by_policy: true,
      normalized_result: { status: 'access_denied' },
    });
  });

  it('contains handler exceptions and only alerts for production execution', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('private failure detail'));
    const execute = createAddieToolExecutor([tool], new Map([['lookup', handler]]), {
      executionMode: 'production',
      policy: () => ({ allowed: true }),
      notificationContext: { threadId: 'thread_1' },
    });

    const result = await execute(call(), 1);

    expect(result.result).toMatchObject({ isError: true });
    expect(result.execution.result).toContain('private failure detail');
    expect(notifyToolError).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'lookup',
      errorMessage: 'private failure detail',
      threadId: 'thread_1',
    }));
  });

  it('expresses multimodal results in canonical model content', async () => {
    const marker = '__MULTIMODAL_CONTENT__'
      + JSON.stringify({ type: 'image', data: 'aW1hZ2U=', media_type: 'image/png', filename: 'chart.png' })
      + '__END_MULTIMODAL__';
    const execute = createAddieToolExecutor(
      [tool],
      new Map([['lookup', vi.fn().mockResolvedValue(marker)]]),
      { executionMode: 'production', policy: () => ({ allowed: true }) },
    );

    const result = await execute(call(), 1);

    expect(result.result.content).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
      { type: 'text', text: '[Image: chart.png]' },
    ]);
    expect(result.execution.result).toBe('Loaded image: chart.png');
  });
});

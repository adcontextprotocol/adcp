import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: vi.fn(() => log),
}));

import { deliverAndRecordDirectMessage } from '../../src/addie/direct-message-delivery.js';

function makeInput(overrides: { userMessageFlagged?: boolean; assistantFlagged?: boolean } = {}) {
  const postMessage = vi.fn();
  const addMessage = vi.fn().mockResolvedValue(undefined);
  const flagThread = vi.fn().mockResolvedValue(undefined);
  return {
    input: {
      channelId: 'D123',
      userId: 'U123',
      threadId: 'thread-1',
      assistantMessage: {
        thread_id: 'thread-1',
        role: 'assistant' as const,
        content: 'Done.',
        tools_used: ['update_profile'],
        tool_calls: [{ name: 'update_profile', input: { name: 'Ari' }, result: 'updated' }],
      },
      userMessageFlagged: overrides.userMessageFlagged ?? false,
      assistantFlagged: overrides.assistantFlagged ?? true,
      flagReason: 'assistant output flagged',
      dependencies: { postMessage, addMessage, flagThread },
    },
    postMessage,
    addMessage,
    flagThread,
  };
}

describe('direct-message delivery orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a replayable internal tool marker when a DM is permanently read-only', async () => {
    const fixture = makeInput();
    fixture.postMessage.mockRejectedValue({
      data: { error: 'restricted_action_read_only_channel' },
    });

    const result = await deliverAndRecordDirectMessage(fixture.input);

    expect(result).toMatchObject({ delivered: false, permanentFailure: true, errorCode: 'restricted_action_read_only_channel' });
    expect(fixture.addMessage).toHaveBeenCalledOnce();
    expect(fixture.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      tool_calls: fixture.input.assistantMessage.tool_calls,
      flag_reason: 'Slack delivery failed: restricted_action_read_only_channel',
    }));
    expect(fixture.flagThread).toHaveBeenCalledWith('thread-1', 'Slack delivery failed: restricted_action_read_only_channel');
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('records tool executions and logs an error for transient delivery failures', async () => {
    const fixture = makeInput();
    fixture.postMessage.mockRejectedValue({ data: { error: 'ratelimited' } });

    const result = await deliverAndRecordDirectMessage(fixture.input);

    expect(result).toMatchObject({ delivered: false, permanentFailure: false, errorCode: 'ratelimited' });
    expect(fixture.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant' }));
    expect(fixture.flagThread).toHaveBeenCalledWith('thread-1', 'Slack delivery failed: ratelimited');
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('persists and flags a successfully delivered assistant response', async () => {
    const fixture = makeInput();
    fixture.postMessage.mockResolvedValue({ ts: '123.456' });

    const result = await deliverAndRecordDirectMessage(fixture.input);

    expect(result).toMatchObject({ delivered: true, responseTs: '123.456', permanentFailure: false });
    expect(fixture.addMessage).toHaveBeenCalledWith(fixture.input.assistantMessage);
    expect(fixture.flagThread).toHaveBeenCalledWith('thread-1', 'assistant output flagged');
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('still flags a rejected inbound user message when delivery fails', async () => {
    const fixture = makeInput({ userMessageFlagged: true, assistantFlagged: false });
    fixture.postMessage.mockRejectedValue(new Error('network failed'));

    await deliverAndRecordDirectMessage(fixture.input);

    expect(fixture.flagThread).toHaveBeenCalledWith(
      'thread-1',
      'assistant output flagged; Slack delivery failed: unknown_error',
    );
  });

  it('does not persist or assistant-flag an undelivered plain response', async () => {
    const fixture = makeInput({ assistantFlagged: true });
    fixture.input.assistantMessage.tools_used = [];
    fixture.input.assistantMessage.tool_calls = [];
    fixture.postMessage.mockRejectedValue(new Error('network failed'));

    const result = await deliverAndRecordDirectMessage(fixture.input);

    expect(result.delivered).toBe(false);
    expect(fixture.addMessage).not.toHaveBeenCalled();
    expect(fixture.flagThread).not.toHaveBeenCalled();
  });
});

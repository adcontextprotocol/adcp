import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing module
const mockSendChannelMessage = vi.fn().mockResolvedValue(undefined);
const mockGetErrorChannel = vi.fn().mockResolvedValue({ channel_id: 'C123', channel_name: 'errors' });

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mockSendChannelMessage,
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getErrorChannel: mockGetErrorChannel,
}));

// Dynamic import after mocks are set up
const { notifyToolError, notifySystemError } = await import('../../src/addie/error-notifier.js');

// Use unique names per test to avoid throttle collisions (module is a singleton)
let testCounter = 0;
function uniqueName(prefix: string) {
  return `${prefix}_${++testCounter}`;
}

describe('error-notifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('notifyToolError', () => {
    it('posts tool errors to the error channel', async () => {
      const name = uniqueName('tool');
      notifyToolError({
        toolName: name,
        errorMessage: 'Stripe API error',
        threw: true,
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      expect(mockSendChannelMessage).toHaveBeenCalledWith('C123', {
        text: expect.stringContaining(name),
      });
    });

    it('includes user and thread info when provided', async () => {
      const name = uniqueName('tool_ctx');
      notifyToolError({
        toolName: name,
        errorMessage: 'fail',
        slackUserId: 'U999',
        threadId: 'thread-abc',
        threw: false,
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      const text = mockSendChannelMessage.mock.calls[0][1].text;
      expect(text).toContain('<@U999>');
      expect(text).toContain('thread-abc');
    });

    it('sanitizes display names containing Slack formatting characters', async () => {
      const name = uniqueName('tool_sanitize');
      notifyToolError({
        toolName: name,
        errorMessage: 'fail',
        userDisplayName: '<script>*bold*_italic_',
        threadId: 'thread-san',
        threw: true,
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      const text = mockSendChannelMessage.mock.calls[0][1].text;
      expect(text).toContain('script');
      expect(text).not.toContain('<script>');
      expect(text).not.toContain('*bold*');
    });

    it('includes tool input and web user display name', async () => {
      const name = uniqueName('tool_input');
      notifyToolError({
        toolName: name,
        errorMessage: 'invalid input syntax for type uuid',
        toolInput: { attempt_id: 'S1', scores: { mastery: 80 } },
        userDisplayName: 'Bryan',
        threadId: 'thread-xyz',
        threw: true,
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      const text = mockSendChannelMessage.mock.calls[0][1].text;
      expect(text).toContain('"attempt_id":"S1"');
      expect(text).toContain('Bryan (web)');
    });

    it('redacts sensitive keys from tool input', async () => {
      const name = uniqueName('tool_redact');
      notifyToolError({
        toolName: name,
        errorMessage: 'auth failure',
        toolInput: { attempt_id: 'S1', token: 'sk-secret-value', api_key: 'key123' },
        threw: true,
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      const text = mockSendChannelMessage.mock.calls[0][1].text;
      expect(text).toContain('[redacted]');
      expect(text).not.toContain('sk-secret-value');
      expect(text).not.toContain('key123');
    });
  });

  describe('notifySystemError', () => {
    it('posts system errors to the error channel', async () => {
      const source = uniqueName('db-pool');
      notifySystemError({
        source,
        errorMessage: 'Connection terminated unexpectedly',
      });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      const callArgs = mockSendChannelMessage.mock.calls[0];
      expect(callArgs[0]).toBe('C123');
      expect(callArgs[1].text).toContain(source);
      expect(callArgs[1].text).toContain('Connection terminated unexpectedly');
    });

    it('throttles repeated system errors from the same source', async () => {
      const source = uniqueName('throttle-test');

      notifySystemError({ source, errorMessage: 'error 1' });
      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalledTimes(1));

      notifySystemError({ source, errorMessage: 'error 2' });
      await new Promise((r) => setTimeout(r, 100));

      // Still 1 — second call was throttled
      expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    });

    it('allows errors from different sources', async () => {
      const source1 = uniqueName('job-a');
      const source2 = uniqueName('job-b');

      notifySystemError({ source: source1, errorMessage: 'timeout' });
      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalledTimes(1));

      notifySystemError({ source: source2, errorMessage: 'timeout' });
      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalledTimes(2));
    });
  });
});

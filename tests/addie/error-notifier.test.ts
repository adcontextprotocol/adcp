import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetErrorChannel, mockSendChannelMessage } = vi.hoisted(() => ({
  mockGetErrorChannel: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getErrorChannel: mockGetErrorChannel,
}));

vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: mockSendChannelMessage,
}));

import { notifyToolError, notifySystemError } from '../../server/src/addie/error-notifier.js';

// The module caches the error channel to survive DB outages, so all tests
// must configure the mock *before* the first call in the suite (or use a
// channel that persists across the cache TTL). We default to a configured
// channel and test the positive paths.
describe('error-notifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetErrorChannel.mockResolvedValue({ channel_id: 'C_ERROR_123', channel_name: 'errors' });
    mockSendChannelMessage.mockResolvedValue({ ok: true });
  });

  test('posts to error channel when configured', async () => {
    notifyToolError({
      toolName: 'create_payment_link',
      errorMessage: 'Cannot create payment link without an account',
      slackUserId: 'U_JAMES_123',
      threadId: 'thread_abc',
      threw: false,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockSendChannelMessage).toHaveBeenCalledWith(
      'C_ERROR_123',
      expect.objectContaining({
        text: expect.stringContaining('create_payment_link'),
      }),
      // error_slack_channel is admin-configured. 'strict-public-only'
      // drops only on confirmed drift — transient Slack failures don't
      // silence system-error alerting (#2735 follow-up).
      { requirePrivate: 'strict-public-only' },
    );

    // Verify it includes the user mention and thread link
    const message = mockSendChannelMessage.mock.calls[0][1].text;
    expect(message).toContain('<@U_JAMES_123>');
    expect(message).toContain('thread_abc');
  });

  test('includes "exception" label when tool threw', async () => {
    notifyToolError({
      toolName: 'search_documents',
      errorMessage: 'Database connection failed',
      threw: true,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    const message = mockSendChannelMessage.mock.calls[0][1].text;
    expect(message).toContain('Tool exception');
  });

  test('includes "error" label when tool returned error string', async () => {
    notifyToolError({
      toolName: 'find_membership_products',
      errorMessage: 'Error: no workspace',
      threw: false,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    const message = mockSendChannelMessage.mock.calls[0][1].text;
    expect(message).toContain('Tool error');
  });

  test('throttles repeated errors from the same tool', async () => {
    // Use a unique tool name not used by other tests
    notifyToolError({
      toolName: 'send_invoice',
      errorMessage: 'Error 1',
      threw: false,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    notifyToolError({
      toolName: 'send_invoice',
      errorMessage: 'Error 2',
      threw: false,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should only post once due to throttle
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
  });

  test('does not swallow errors — notifyToolError never throws', async () => {
    mockGetErrorChannel.mockRejectedValue(new Error('DB down'));

    // Should not throw
    expect(() => {
      notifyToolError({
        toolName: 'some_tool',
        errorMessage: 'some error',
        threw: true,
      });
    }).not.toThrow();

    await new Promise(resolve => setTimeout(resolve, 50));
  });

  test('notifySystemError posts system errors', async () => {
    notifySystemError({
      source: 'database-pool',
      errorMessage: 'Connection terminated unexpectedly',
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockSendChannelMessage).toHaveBeenCalledWith(
      'C_ERROR_123',
      expect.objectContaining({
        text: expect.stringContaining('database-pool'),
      }),
      { requirePrivate: 'strict-public-only' },
    );
  });
});

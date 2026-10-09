import { describe, expect, it, vi } from 'vitest';
import { scheduleWebRelationshipAnalytics } from '../../../src/addie/services/web-relationship-analytics.js';

describe('deferred web relationship analytics', () => {
  it('never awaits a 109-second-class relationship lookup on the response path', async () => {
    let scheduled: (() => void) | undefined;
    let resolvePerson!: (personId: string) => void;
    const blockedLookup = new Promise<string>(resolve => { resolvePerson = resolve; });
    const recordPersonMessage = vi.fn().mockResolvedValue(undefined);
    const deriveSentiment = vi.fn().mockResolvedValue(undefined);
    const recordEvent = vi.fn().mockResolvedValue(undefined);

    const detached = scheduleWebRelationshipAnalytics(
      { userId: 'user-1', sanitizedMessage: 'safe message', source: 'web_chat_stream' },
      {
        resolvePersonId: vi.fn(() => blockedLookup),
        recordPersonMessage,
        deriveSentiment,
        recordEvent,
        buildMessageReceivedData: vi.fn(() => ({ safe: true })),
        schedule: callback => { scheduled = callback; },
      },
    );

    expect(detached.scheduleMs).toBeGreaterThanOrEqual(0);
    expect(scheduled).toBeTypeOf('function');
    expect(recordPersonMessage).not.toHaveBeenCalled();
    scheduled?.();
    await Promise.resolve();
    expect(recordPersonMessage).not.toHaveBeenCalled();

    resolvePerson('person-1');
    await expect(detached.completion).resolves.toMatchObject({ outcome: 'completed' });
    expect(recordPersonMessage).toHaveBeenCalledWith('person-1', 'web');
    expect(deriveSentiment).toHaveBeenCalledWith('person-1');
    expect(recordEvent).toHaveBeenCalledWith('person-1', 'message_received', expect.any(Object));
  });

  it('contains analytics failures and reports a failed outcome', async () => {
    const detached = scheduleWebRelationshipAnalytics(
      { userId: 'user-1', sanitizedMessage: 'safe message', source: 'web_chat' },
      {
        resolvePersonId: vi.fn().mockRejectedValue(new Error('lock timeout')),
        recordPersonMessage: vi.fn(),
        deriveSentiment: vi.fn(),
        recordEvent: vi.fn(),
        buildMessageReceivedData: vi.fn(),
        schedule: callback => callback(),
      },
    );
    await expect(detached.completion).resolves.toMatchObject({ outcome: 'failed' });
  });
});

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

function fakeClient(acquired: boolean) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    release: vi.fn(),
  };
}

describe('newsletter send lock', () => {
  it('allows only one sender to enter delivery for an edition', async () => {
    const firstClient = fakeClient(true);
    const secondClient = fakeClient(false);
    mocks.connect
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstWork = vi.fn(async () => {
      firstStarted();
      await firstCanFinish;
      return 'sent';
    });
    const secondWork = vi.fn(async () => 'duplicate');

    const { withNewsletterSendLock } = await import('../../src/newsletters/send-lock.js');
    const first = withNewsletterSendLock('the_prompt', 42, firstWork);
    await firstDidStart;
    const second = await withNewsletterSendLock('the_prompt', 42, secondWork);

    expect(second).toEqual({ acquired: false });
    expect(secondWork).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ acquired: true, value: 'sent' });
    expect(firstClient.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
      ['newsletter-send:the_prompt:42'],
    );
    expect(firstClient.release).toHaveBeenCalledWith(false);
    expect(secondClient.release).toHaveBeenCalledWith(false);
  });
});

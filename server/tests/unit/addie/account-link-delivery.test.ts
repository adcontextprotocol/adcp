import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAccountLinkDelivery } from '../../../src/addie/account-link-delivery.js';

describe('account-link delivery wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a successful delivery that settles within the callback budget', async () => {
    await expect(waitForAccountLinkDelivery(
      async () => true,
      { timeoutMs: 100 },
    )).resolves.toEqual({ status: 'settled', delivered: true });
  });

  it('returns a delivery failure that settles within the callback budget', async () => {
    await expect(waitForAccountLinkDelivery(
      async () => false,
      { timeoutMs: 100 },
    )).resolves.toEqual({ status: 'settled', delivered: false });
  });

  it('contains an unexpected delivery rejection so authentication can continue', async () => {
    const failure = new Error('synthetic Slack failure');
    await expect(waitForAccountLinkDelivery(
      async () => { throw failure; },
      { timeoutMs: 100 },
    )).resolves.toEqual({ status: 'rejected', error: failure });
  });

  it('bounds the callback wait and observes a late success', async () => {
    vi.useFakeTimers();
    let finishDelivery!: (delivered: boolean) => void;
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const onLateSettlement = vi.fn();
    const waiting = waitForAccountLinkDelivery(
      () => delivery,
      { timeoutMs: 25, onLateSettlement },
    );

    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).resolves.toEqual({ status: 'timed_out' });

    finishDelivery(true);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(onLateSettlement).toHaveBeenCalledWith({ status: 'settled', delivered: true });
    });
  });

  it('observes a late rejection without surfacing an unhandled promise', async () => {
    vi.useFakeTimers();
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<boolean>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const onLateSettlement = vi.fn();
    const waiting = waitForAccountLinkDelivery(
      () => delivery,
      { timeoutMs: 25, onLateSettlement },
    );

    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).resolves.toEqual({ status: 'timed_out' });

    const failure = new Error('late synthetic Slack failure');
    rejectDelivery(failure);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(onLateSettlement).toHaveBeenCalledWith({ status: 'rejected', error: failure });
    });
  });
});

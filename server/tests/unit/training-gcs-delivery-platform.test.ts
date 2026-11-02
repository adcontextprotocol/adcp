import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdcpError } from '@adcp/sdk/server';
import * as handlers from '../../src/training-agent/task-handlers.js';
import * as source from '../../src/training-agent/gcs-reporting-tools.js';
import { TrainingSalesPlatform } from '../../src/training-agent/v6-sales-platform.js';

const principal = 'workos:gcs-platform-test';
const account = { account_id: 'gcs-platform-account' };
const request = {
  account,
  media_buy_ids: ['gcs-platform-buy'],
  start_date: '2026-10-01',
  end_date: '2026-10-02',
};
const delivery = {
  reporting_period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
  media_buy_deliveries: [{ media_buy_id: 'gcs-platform-buy', totals: { impressions: 123 } }],
};
const context = {
  authInfo: { clientId: principal },
  account: { id: account.account_id, ctx_metadata: { account_ref: account } },
  input: request,
};

afterEach(() => { vi.restoreAllMocks(); });

describe.each(['canonical', 'legacy'] as const)('%s delivery source publication', path => {
  const read = () => {
    const platform = new TrainingSalesPlatform();
    const surface = path === 'canonical' ? platform.mediaBuyLifecycle! : platform.sales;
    return surface.getMediaBuyDelivery!(request as never, context as never);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(handlers, 'handleGetMediaBuyDelivery').mockResolvedValue(delivery);
    vi.spyOn(source, 'publishTrainingGcsSourceDelivery').mockResolvedValue(undefined);
  });

  it('publishes the returned source metrics under the authenticated account before returning', async () => {
    const result = await read();
    expect(result).toEqual(delivery);
    expect(handlers.handleGetMediaBuyDelivery).toHaveBeenCalledOnce();
    expect(source.publishTrainingGcsSourceDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(request), delivery, principal,
    );
    expect(vi.mocked(handlers.handleGetMediaBuyDelivery).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(source.publishTrainingGcsSourceDelivery).mock.invocationCallOrder[0]);
  });

  it('waits for durable publication rather than returning a successful read early', async () => {
    let release!: () => void;
    vi.mocked(source.publishTrainingGcsSourceDelivery).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let returned = false;
    const pending = read().then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(source.publishTrainingGcsSourceDelivery).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    release();
    expect(await pending).toEqual(delivery);
  });

  it('propagates a durable publication failure instead of acknowledging the read', async () => {
    vi.mocked(source.publishTrainingGcsSourceDelivery).mockRejectedValue(new AdcpError('SERVICE_UNAVAILABLE', {
      recovery: 'transient', message: 'Daily reporting source publication is unavailable.',
    }));
    await expect(read()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('does not publish after the delivery read throws', async () => {
    vi.mocked(handlers.handleGetMediaBuyDelivery).mockRejectedValue(new Error('Delivery source unavailable'));
    await expect(read()).rejects.toThrow('Delivery source unavailable');
    expect(source.publishTrainingGcsSourceDelivery).not.toHaveBeenCalled();
  });
});

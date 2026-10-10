import { beforeEach, describe, expect, it, vi } from 'vitest';
const shared = vi.hoisted(() => ({ runtime: undefined as unknown, getRuntime: vi.fn(), config: vi.fn(), resolve: vi.fn(), commit: vi.fn() }));
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: shared.getRuntime }));
vi.mock('../../src/training-agent/gcs-reporting-config.js', () => ({ trainingGcsReportingConfig: shared.config }));
vi.mock('../../src/training-agent/reporting-reliability.js', () => ({ resolveReportingAccountDurably: shared.resolve, commitTrainingDailySourcePeriod: shared.commit }));
vi.mock('../../src/training-agent/task-handlers.js', () => ({ resolveServedAdcpVersion: () => ({ ok: true, servedVersion: '3.2.1' }) }));
import { dispatchTrainingGcsReporting, publishTrainingGcsSourceDelivery } from '../../src/training-agent/gcs-reporting-tools.js';

beforeEach(() => {
  shared.getRuntime.mockReset().mockImplementation(() => shared.runtime);
  shared.config.mockReset();
});

const actor = 'workos:private';
const input = { account: { account_id: 'caller-alias' }, delivery_config_ids: ['gcs:daily'], view: 'periods' };
const runtime = { owns: vi.fn(), service: { stores: { core: { getRevision: vi.fn() } }, platform: { getReportingStatus: vi.fn(), syncReportingReceipts: vi.fn() } } };
describe('GCS reporting dispatch boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.runtime = undefined;
    shared.resolve.mockResolvedValue({ accountId: 'resolved-account' });
    runtime.owns.mockResolvedValue(true);
    runtime.service.platform.getReportingStatus.mockResolvedValue({ status: 'completed' });
    runtime.service.stores.core.getRevision.mockResolvedValue(null);
  });
  it('refuses a named GCS configuration while disabled without falling back to a fixture', async () => {
    await expect(dispatchTrainingGcsReporting('get_reporting_status', input, actor)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(shared.resolve).not.toHaveBeenCalled();
  });
  it('retains explicitly selected teaching source configuration behavior', async () => {
    expect(await dispatchTrainingGcsReporting('get_reporting_status', { ...input, delivery_config_ids: ['daily'] }, actor)).toBeUndefined();
  });
  it('retains teaching consumer status after an account is provisioned for GCS', async () => {
    shared.runtime = runtime;
    expect(await dispatchTrainingGcsReporting('sync_reporting_status', { account: input.account, statuses: [{ delivery_config_id: 'daily' }] }, actor)).toBeUndefined();
    expect(runtime.owns).not.toHaveBeenCalled();
  });
  it('retains teaching receipt behavior when its revision belongs to the source ledger', async () => {
    shared.runtime = runtime;
    expect(await dispatchTrainingGcsReporting('sync_reporting_receipts', { account: input.account, receipts: [{ reporting_revision_id: 'teaching-revision' }] }, actor)).toBeUndefined();
    expect(runtime.service.stores.core.getRevision).toHaveBeenCalledWith('teaching-revision', 'resolved-account');
    expect(runtime.service.platform.syncReportingReceipts).not.toHaveBeenCalled();
  });
  it('refuses a receipt batch that mixes GCS and source revisions', async () => {
    shared.runtime = runtime;
    runtime.service.stores.core.getRevision.mockResolvedValueOnce({ reporting_revision_id: 'gcs-revision' }).mockResolvedValueOnce(null);
    await expect(dispatchTrainingGcsReporting('sync_reporting_receipts', { account: input.account, receipts: [{ reporting_revision_id: 'gcs-revision' }, { reporting_revision_id: 'teaching-revision' }] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(runtime.service.platform.syncReportingReceipts).not.toHaveBeenCalled();
  });
  it('passes independently resolved account ownership and authenticated identity to the SDK', async () => {
    shared.runtime = runtime;
    expect(await dispatchTrainingGcsReporting('get_reporting_status', input, actor)).toEqual({ status: 'completed' });
    expect(runtime.owns).toHaveBeenCalledWith(actor, 'resolved-account');
    expect(runtime.service.platform.getReportingStatus).toHaveBeenCalledWith({ ...input, account: { account_id: 'resolved-account' } }, expect.objectContaining({ authInfo: { clientId: actor }, account: expect.objectContaining({ id: 'resolved-account' }) }));
  });
  it('refuses an unowned GCS account without exposing source fixtures', async () => {
    shared.runtime = runtime;
    runtime.owns.mockResolvedValue(false);
    await expect(dispatchTrainingGcsReporting('get_reporting_status', input, actor)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(runtime.service.platform.getReportingStatus).not.toHaveBeenCalled();
  });
  it('refuses a mixed ledger snapshot instead of blending independent authorities', async () => {
    shared.runtime = runtime;
    await expect(dispatchTrainingGcsReporting('get_reporting_status', { ...input, delivery_config_ids: ['gcs:daily', 'daily'] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(runtime.service.platform.getReportingStatus).not.toHaveBeenCalled();
  });
});

describe('private GCS source publication from ordinary delivery', () => {
  const source = { source_config_id: 'daily', source_config_version: 1, media_buy_ids: ['buy-a', 'buy-b'] };
  const host = { config: { canaryPrincipal: actor }, owns: vi.fn(), db: { query: vi.fn() } };
  const read = { account: input.account, media_buy_ids: source.media_buy_ids, start_date: '2026-10-01', end_date: '2026-10-02' };
  const response = { reporting_period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
    media_buy_deliveries: [{ media_buy_id: 'buy-b', totals: { impressions: 11 } }, { media_buy_id: 'buy-a', totals: { impressions: 7 } }] };
  beforeEach(() => {
    vi.clearAllMocks();shared.runtime = host;
    shared.config.mockReturnValue({ canaryPrincipal: actor });
    shared.resolve.mockResolvedValue({ accountId: 'resolved-account' });
    host.owns.mockResolvedValue(true);host.db.query.mockResolvedValue({ rows: [source] });
    shared.commit.mockResolvedValue(true);
  });
  it('commits actual aggregate metrics under the saved principal, source version and exact scope', async () => {
    await publishTrainingGcsSourceDelivery(read, response, actor);
    expect(shared.commit).toHaveBeenCalledWith({ principal: actor, accountId: 'resolved-account', sourceConfigId: 'daily', sourceConfigVersion: 1,
      mediaBuyIds: source.media_buy_ids, period: response.reporting_period, impressions: 18 });
  });
  it.each([
    ['partial scope', { ...read, media_buy_ids: ['buy-a'] }, response],
    ['missing buy', read, { ...response, media_buy_deliveries: response.media_buy_deliveries.slice(0, 1) }],
    ['duplicate buy', read, { ...response, media_buy_deliveries: [response.media_buy_deliveries[0], response.media_buy_deliveries[0]] }],
    ['wrong period', read, { ...response, reporting_period: { ...response.reporting_period, end: '2026-10-03T00:00:00.000Z' } }],
    ['failed delivery', read, { ...response, errors: [{ code: 'SERVICE_UNAVAILABLE' }] }],
    ['missing metric', read, { ...response, media_buy_deliveries: [{ media_buy_id: 'buy-a' }, response.media_buy_deliveries[0]] }],
    ['fractional metric', read, { ...response, media_buy_deliveries: [{ media_buy_id: 'buy-a', totals: { impressions: 0.5 } }, response.media_buy_deliveries[0]] }],
  ])('does not publish %s as complete source evidence', async (_name, request, result) => {
    await publishTrainingGcsSourceDelivery(request, result, actor);
    expect(shared.commit).not.toHaveBeenCalled();
  });
  it('does not publish for a foreign principal or an unowned account', async () => {
    await publishTrainingGcsSourceDelivery(read, response, 'workos:foreign');
    expect(shared.resolve).not.toHaveBeenCalled();
    host.owns.mockResolvedValue(false);
    await publishTrainingGcsSourceDelivery(read, response, actor);
    expect(shared.commit).not.toHaveBeenCalled();
  });
  it('preserves disabled teaching behavior', async () => {
    shared.config.mockReturnValue(undefined);
    shared.getRuntime.mockImplementation(() => { throw new Error('runtime unavailable'); });
    await publishTrainingGcsSourceDelivery(read, response, actor);
    expect(shared.getRuntime).not.toHaveBeenCalled();
    expect(shared.resolve).not.toHaveBeenCalled();
  });
  it.each(['uninitialized', 'draining'])('preserves other callers when the enabled runtime is %s', async state => {
    shared.getRuntime.mockImplementation(() => { throw new Error(`runtime ${state}`); });
    await expect(publishTrainingGcsSourceDelivery(read, response, 'workos:foreign')).resolves.toBeUndefined();
    await expect(publishTrainingGcsSourceDelivery(read, response, undefined)).resolves.toBeUndefined();
    expect(shared.getRuntime).not.toHaveBeenCalled();
    expect(shared.resolve).not.toHaveBeenCalled();
    expect(shared.commit).not.toHaveBeenCalled();
  });
  it.each(['uninitialized', 'draining'])('fails closed for the canary when the enabled runtime is %s', async state => {
    shared.getRuntime.mockImplementation(() => { throw new Error(`runtime ${state}`); });
    await expect(publishTrainingGcsSourceDelivery(read, response, actor)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE', message: 'Daily reporting source publication is unavailable.',
    });
    expect(shared.commit).not.toHaveBeenCalled();
  });
  it('fails closed with a fixed dependency error if the durable source write fails', async () => {
    shared.commit.mockRejectedValue(new Error('private dependency diagnostic'));
    await expect(publishTrainingGcsSourceDelivery(read, response, actor)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE', message: 'Daily reporting source publication is unavailable.',
    });
  });
});

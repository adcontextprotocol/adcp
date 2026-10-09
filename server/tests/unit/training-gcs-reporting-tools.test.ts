import { beforeEach, describe, expect, it, vi } from 'vitest';
const shared = vi.hoisted(() => ({ runtime: undefined as unknown, resolve: vi.fn() }));
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: () => shared.runtime }));
vi.mock('../../src/training-agent/reporting-reliability.js', () => ({ resolveReportingAccountDurably: shared.resolve }));
vi.mock('../../src/training-agent/task-handlers.js', () => ({ resolveServedAdcpVersion: () => ({ ok: true, servedVersion: '3.2.1' }) }));
import { dispatchTrainingGcsReporting } from '../../src/training-agent/gcs-reporting-tools.js';

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

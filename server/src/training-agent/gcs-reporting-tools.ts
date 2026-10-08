import type { LegacyAdcpToolMap as AdcpToolMap, RequestContext, Account } from '@adcp/sdk/server';
import { AdcpError } from '@adcp/sdk/server';
import { getTrainingGcsReporting } from './gcs-reporting.js';
import { resolveReportingAccountDurably } from './reporting-reliability.js';
import { resolveServedAdcpVersion } from './task-handlers.js';
import { supportsReliableReporting } from './types.js';

type Operation = 'get_reporting_status' | 'get_media_buy_delivery' | 'sync_reporting_status' | 'sync_reporting_receipts';
/** Existing tools retain their fixture behavior unless this caller provisioned a GCS account. */
export async function dispatchTrainingGcsReporting<T extends Operation>(operation: T, input: Record<string, unknown>, principal: string | undefined): Promise<AdcpToolMap[T]['result'] | undefined> {
  const configIds = operation === 'sync_reporting_status' && Array.isArray(input.statuses)
    ? input.statuses.map(status => status && typeof status === 'object' ? status.delivery_config_id : undefined)
    : Array.isArray(input.delivery_config_ids) ? input.delivery_config_ids : [];
  const selectsGcs = configIds.some(id => typeof id === 'string' && id.startsWith('gcs:'));
  if ((operation === 'get_reporting_status' || operation === 'sync_reporting_status') && configIds.length > 0 && !selectsGcs) return undefined;
  const runtime = getTrainingGcsReporting();
  if (!runtime && selectsGcs) throw new AdcpError('SERVICE_UNAVAILABLE', { recovery: 'transient', message: 'Durable reporting is unavailable.' });
  if (!runtime || !input.account) return undefined;
  if (operation === 'get_media_buy_delivery' && !input.reporting_revision_id) return undefined;
  const version = resolveServedAdcpVersion(input);
  if (!version.ok || !supportsReliableReporting(version.servedVersion)) return undefined;
  const account = await resolveReportingAccountDurably(principal, input.account as never);
  if (!account || !await runtime.owns(principal, account.accountId)) {
    if (selectsGcs) throw new AdcpError('ACCOUNT_NOT_FOUND', { message: 'Reporting account was not found.' });
    return undefined;
  }
  if (selectsGcs && configIds.some(id => typeof id !== 'string' || !id.startsWith('gcs:'))) {
    throw new AdcpError('VALIDATION_ERROR', { message: 'Select the GCS reporting configuration separately from teaching configurations.' });
  }
  if (operation === 'sync_reporting_receipts') {
    const revisions = [
      ...(Array.isArray(input.receipts) ? input.receipts.map(receipt => receipt?.reporting_revision_id) : []),
      ...(Array.isArray(input.adjustment_receipts) ? input.adjustment_receipts.map(receipt => receipt?.adjusts_reporting_revision_id) : []),
    ].filter((id): id is string => typeof id === 'string');
    if (revisions.length > 100) throw new AdcpError('VALIDATION_ERROR', { message: 'Reporting receipt batches are limited to 100 entries.' });
    if (revisions.length) {
      const known = await Promise.all(revisions.map(id => runtime.service.stores.core.getRevision(id, account.accountId)));
      if (known.every(revision => !revision)) return undefined;
      if (known.some(revision => !revision)) throw new AdcpError('VALIDATION_ERROR', { message: 'Submit receipts for one reporting ledger at a time.' });
    }
  }
  const context = { account: { id: account.accountId, ctx_metadata: {} }, authInfo: { clientId: principal } } as RequestContext<Account>;
  const params = { ...input, account: { account_id: account.accountId } };
  if (operation === 'get_media_buy_delivery') {
    if (!await runtime.service.stores.core.getRevision(String(input.reporting_revision_id), account.accountId)) return undefined;
    return await runtime.service.platform.getMediaBuyDelivery(params as unknown as AdcpToolMap['get_media_buy_delivery']['params'], context) as AdcpToolMap[T]['result'];
  }
  if (operation === 'get_reporting_status') return await runtime.service.platform.getReportingStatus(params as unknown as AdcpToolMap['get_reporting_status']['params'], context) as AdcpToolMap[T]['result'];
  if (operation === 'sync_reporting_status') {
    if (!runtime.service.platform.syncReportingStatus) throw new AdcpError('SERVICE_UNAVAILABLE', { recovery: 'transient', message: 'Reporting status ingest is unavailable.' });
    return await runtime.service.platform.syncReportingStatus(params as unknown as AdcpToolMap['sync_reporting_status']['params'], context) as AdcpToolMap[T]['result'];
  }
  if (!runtime.service.platform.syncReportingReceipts) throw new AdcpError('SERVICE_UNAVAILABLE', { recovery: 'transient', message: 'Reporting receipt ingest is unavailable.' });
  return await runtime.service.platform.syncReportingReceipts(params as unknown as AdcpToolMap['sync_reporting_receipts']['params'], context) as AdcpToolMap[T]['result'];
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { GetReportingStatusResponseSchema } from '@adcp/sdk/schemas';
import { createTrainingAgentRouter } from '../../src/training-agent/index.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import {
  clearReportingReliabilityStore,
  TRAINING_REPORTING_DEFINITION_BYTES,
  TRAINING_REPORTING_CORE_CONFIGURATION,
  TRAINING_REPORTING_CORE_OFFERING,
  TRAINING_REPORTING_ROW_SCHEMA_BYTES,
} from '../../src/training-agent/reporting-reliability.js';
import {
  clearSessions,
  flushDirtySessions,
  getSession,
  runWithSessionContext,
  sessionKeyFromArgs,
  stopSessionCleanup,
} from '../../src/training-agent/state.js';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import type { MediaBuyState } from '../../src/training-agent/types.js';

const PUBLIC_TEST_TOKEN = '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';
const ADCP_VERSION = '3.2-beta.11';

async function boot(): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/training-agent', createTrainingAgentRouter());
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/api/training-agent/sales/mcp`,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function call(url: string, id: number, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${PUBLIC_TEST_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown> } };
  } catch {
    throw new Error(`${name} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function initialize(url: string): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${PUBLIC_TEST_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'reporting-test', version: '1' }, capabilities: {} },
    }),
  });
}

describe('sales training-agent reporting Core exercise', () => {
  beforeEach(() => {
    clearSessions();
    clearAccountStore();
    clearReportingReliabilityStore();
  });
  afterEach(() => {
    clearSessions();
    clearAccountStore();
    clearReportingReliabilityStore();
    stopSessionCleanup();
  });

  it('advertises Core honestly and runs the immediate missing-first then zero-row lab', async () => {
    const { url, close } = await boot();
    const account = {
      brand: { domain: 'reporting-lab.example' },
      operator: 'pinnacle-agency.example',
      sandbox: true,
    };
    try {
      await initialize(url);
      const capabilities = await call(url, 1, 'get_adcp_capabilities', { adcp_version: ADCP_VERSION });
      if (!capabilities.result?.structuredContent) throw new Error(JSON.stringify(capabilities));
      const mediaBuy = capabilities.result?.structuredContent?.media_buy as Record<string, unknown> | undefined;
      const reporting = mediaBuy?.reporting_delivery as Record<string, unknown> | undefined;
      expect(capabilities.result?.structuredContent?.experimental_features).toContain('media_buy.reporting_delivery');
      expect(reporting).toMatchObject({
        supported: true,
        configuration_task: 'sync_accounts',
        status_task: 'get_reporting_status',
      });
      expect(reporting).not.toHaveProperty('receipt_task');
      expect(reporting).not.toHaveProperty('readiness_notification');

      const configured = await call(url, 2, 'sync_accounts', {
        adcp_version: ADCP_VERSION,
        idempotency_key: 'reporting-core-configure-0001',
        accounts: [{ ...account, billing: 'operator', reporting_delivery_configs: [TRAINING_REPORTING_CORE_CONFIGURATION] }],
      });
      expect(configured.result?.structuredContent).toMatchObject({
        accounts: [expect.objectContaining({
          action: 'created',
          reporting_delivery_configs: [expect.objectContaining({ state: 'ready' })],
        })],
      });
      const configuredAccountId = (configured.result?.structuredContent?.accounts as Array<{ account_id?: unknown }> | undefined)?.[0]?.account_id;
      expect(configuredAccountId).toEqual(expect.any(String));
      const unknownStatus = await call(url, 21, 'get_reporting_status', {
        account: { account_id: 'acc_unknown_reporting' },
        view: 'summary',
        adcp_version: ADCP_VERSION,
      });
      expect(unknownStatus.result?.structuredContent).toMatchObject({
        status: 'failed',
        failure_kind: 'lookup_unavailable',
        errors: [{ code: 'NOT_FOUND' }],
      });
      const unknownController = await call(url, 22, 'comply_test_controller', {
        account: {
          brand: { domain: 'unknown-reporting.example' },
          operator: 'pinnacle-agency.example',
          sandbox: true,
        },
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'prepare' },
      });
      expect(unknownController.result?.structuredContent).toMatchObject({
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      const unconfiguredAccount = {
        brand: { domain: 'reporting-empty.example' },
        operator: 'pinnacle-agency.example',
        sandbox: true,
      };
      const unconfigured = await call(url, 23, 'sync_accounts', {
        adcp_version: ADCP_VERSION,
        idempotency_key: 'reporting-core-empty-account-0001',
        accounts: [{ ...unconfiguredAccount, billing: 'operator' }],
      });
      expect(unconfigured.result?.structuredContent).toMatchObject({
        accounts: [expect.objectContaining({ action: 'created', reporting_delivery_configs: [] })],
      });
      const emptyStatus = await call(url, 24, 'get_reporting_status', {
        account: unconfiguredAccount,
        view: 'summary',
        adcp_version: ADCP_VERSION,
      });
      expect(emptyStatus.result?.structuredContent).toMatchObject({
        status: 'completed',
        health: 'complete',
        scope: { scope_closed: true, delivery_config_generations: [] },
      });
      const reportingProductId = buildCatalog()[0]?.product.product_id;
      expect(reportingProductId).toEqual(expect.any(String));
      await runWithSessionContext(async () => {
        const mediaBuySession = await getSession(sessionKeyFromArgs(
          { account },
          'open',
          undefined,
          undefined,
          'static:public',
        ));
        mediaBuySession.mediaBuys.set('mb_reporting_core_actual', {
          mediaBuyId: 'mb_reporting_core_actual',
          accountRef: account,
          status: 'active',
          currency: 'USD',
          packages: [{ packageId: 'pkg_reporting_core_actual', productId: reportingProductId }],
          startTime: '2026-07-31T23:00:00.000Z',
          endTime: '2026-08-01T03:00:00.000Z',
          revision: 1,
          confirmedAt: '2026-08-01T00:30:00.000Z',
          createdAt: '2026-08-01T00:30:00.000Z',
          updatedAt: '2026-08-01T00:30:00.000Z',
          history: [],
        } as MediaBuyState);
        await flushDirtySessions();
      });
      const rejectedUnknownScope = await call(url, 25, 'sync_accounts', {
        adcp_version: ADCP_VERSION,
        idempotency_key: 'reporting-core-unknown-scope-0001',
        accounts: [{
          account,
          reporting_delivery_configs: [{
            ...TRAINING_REPORTING_CORE_CONFIGURATION,
            scope: { media_buy_ids: ['mb_not_owned'] },
          }],
        }],
      });
      expect(rejectedUnknownScope.result?.structuredContent).toMatchObject({
        accounts: [expect.objectContaining({
          action: 'failed',
          errors: [expect.objectContaining({
            field: 'reporting_delivery_configs',
            message: expect.stringContaining('unavailable'),
          })],
        })],
      });
      const listed = await call(url, 3, 'list_accounts', { account, adcp_version: ADCP_VERSION });
      expect(listed.result?.structuredContent).toMatchObject({
        accounts: [expect.objectContaining({
          reporting_delivery_configs: [expect.objectContaining({ state: 'ready' })],
        })],
      });
      const dryRun = await call(url, 31, 'sync_accounts', {
        adcp_version: ADCP_VERSION,
        idempotency_key: 'reporting-core-dry-run-0001',
        dry_run: true,
        accounts: [{
          brand: { domain: 'reporting-dry-run.example' },
          operator: 'pinnacle-agency.example',
          billing: 'operator',
          sandbox: true,
          reporting_delivery_configs: [TRAINING_REPORTING_CORE_CONFIGURATION],
        }],
      });
      expect(dryRun.result?.structuredContent).toMatchObject({
        dry_run: true,
        accounts: [expect.objectContaining({
          action: 'created',
          reporting_delivery_configs: [expect.objectContaining({ state: 'ready' })],
        })],
      });
      const afterDryRun = await call(url, 32, 'list_accounts', {
        adcp_version: ADCP_VERSION,
        account: {
          brand: { domain: 'reporting-dry-run.example' },
          operator: 'pinnacle-agency.example',
          sandbox: true,
        },
      });
      expect(afterDryRun.result?.structuredContent).toMatchObject({ accounts: [] });
      const liveAfterDryRun = await call(url, 33, 'sync_accounts', {
        adcp_version: ADCP_VERSION,
        idempotency_key: 'reporting-core-after-dry-run-0001',
        accounts: [{
          brand: { domain: 'reporting-dry-run.example' },
          operator: 'pinnacle-agency.example',
          billing: 'operator',
          sandbox: true,
          reporting_delivery_configs: [TRAINING_REPORTING_CORE_CONFIGURATION],
        }],
      });
      expect(liveAfterDryRun.result?.structuredContent).toMatchObject({
        accounts: [expect.objectContaining({ action: 'created' })],
      });

      const prepared = await call(url, 4, 'comply_test_controller', {
        account,
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'prepare' },
      });
      if (prepared.result?.structuredContent?.success !== true) throw new Error(JSON.stringify(prepared));
      expect(prepared.result?.structuredContent).toMatchObject({
        success: true,
        simulated: {
          account_id: configuredAccountId,
          resolved_configuration: expect.objectContaining({ schedule: { period_duration: 'PT1H', alignment: 'utc', delivery_sla: 'PT1H' } }),
          period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
          expected_at: '2026-08-01T02:00:00.000Z',
          recovery_deadline: '2026-08-01T04:00:00.000Z',
        },
      });

      const waiting = await call(url, 5, 'get_reporting_status', { account, view: 'periods', adcp_version: ADCP_VERSION });
      const waitingPayload = waiting.result?.structuredContent;
      expect(waitingPayload).toMatchObject({
        status: 'completed',
        view: 'periods',
        account_id: configuredAccountId,
        periods: [expect.objectContaining({ health: 'waiting', production_status: 'pending', revision_count: 0 })],
        revisions: [],
      });
      expect(waitingPayload).toMatchObject({
        periods: [expect.objectContaining({
          media_buy_ids: ['mb_reporting_core_actual'],
          coverage: expect.objectContaining({
            status: 'full',
            fully_covered_media_buy_ids: ['mb_reporting_core_actual'],
            package_ids: ['pkg_reporting_core_actual'],
            covered_package_ids: ['pkg_reporting_core_actual'],
          }),
        })],
      });
      expect(GetReportingStatusResponseSchema.safeParse(waitingPayload).success).toBe(true);

      const delayed = await call(url, 6, 'comply_test_controller', {
        account,
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'advance_time', target_health: 'delayed' },
      });
      expect(delayed.result?.structuredContent).toMatchObject({ success: true });
      const overdue = await call(url, 7, 'get_reporting_status', { account, view: 'summary', adcp_version: ADCP_VERSION });
      expect(overdue.result?.structuredContent).toMatchObject({ health: 'delayed' });

      const published = await call(url, 8, 'comply_test_controller', {
        account,
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'publish_zero_row' },
      });
      expect(published.result?.structuredContent).toMatchObject({ success: true });
      const complete = await call(url, 9, 'get_reporting_status', { account, view: 'periods', adcp_version: ADCP_VERSION });
      expect(complete.result?.structuredContent).toMatchObject({
        periods: expect.arrayContaining([expect.objectContaining({ reporting_obligation_id: expect.any(String), production_status: 'published' })]),
        revisions: expect.arrayContaining([expect.objectContaining({ row_count: 0, control_totals: [] })]),
      });

      await call(url, 10, 'comply_test_controller', {
        account,
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'prepare' },
      });
      const omitted = await call(url, 11, 'comply_test_controller', {
        account,
        scenario: 'reporting_core_lifecycle_probe',
        adcp_version: ADCP_VERSION,
        params: { operation: 'omit_obligation' },
      });
      expect(omitted.result?.structuredContent).toMatchObject({
        success: true,
        simulated: {
          account_id: configuredAccountId,
          expected_reporting_obligation_id: expect.any(String),
          omitted_period: { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T02:00:00.000Z' },
        },
      });
      const missing = await call(url, 12, 'get_reporting_status', {
        account,
        view: 'periods',
        period: { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T02:00:00.000Z' },
        adcp_version: ADCP_VERSION,
      });
      expect(missing.result?.structuredContent).toMatchObject({
        scope: { coverage_complete: true },
        periods: [],
        revisions: [],
      });
      expect(GetReportingStatusResponseSchema.safeParse(missing.result?.structuredContent).success).toBe(true);
    } finally {
      await close();
    }
  }, 30000);

  it('serves the immutable schema and definition bytes advertised by the Core offering', async () => {
    const { url, close } = await boot();
    try {
      const base = url.replace('/sales/mcp', '');
      const [schema, definition] = await Promise.all([
        fetch(`${base}/reporting/schemas/delivery-summary-v1.json`).then(async response => ({ response, body: await response.text() })),
        fetch(`${base}/reporting/definitions/delivery-summary-v1.json`).then(async response => ({ response, body: await response.text() })),
      ]);
      expect(schema.response.ok).toBe(true);
      expect(definition.response.ok).toBe(true);
      expect(schema.body).toBe(TRAINING_REPORTING_ROW_SCHEMA_BYTES);
      expect(definition.body).toBe(TRAINING_REPORTING_DEFINITION_BYTES);
      expect(createHash('sha256').update(schema.body).digest('hex'))
        .toBe(TRAINING_REPORTING_CORE_OFFERING.reporting_profile.schema_sha256);
      expect(createHash('sha256').update(definition.body).digest('hex'))
        .toBe(TRAINING_REPORTING_CORE_OFFERING.report_definition_sha256);
      const definitionValidation = validateSourceSchema(
        'core/reporting-report-definition.json',
        JSON.parse(definition.body),
      );
      expect(definitionValidation.valid, JSON.stringify(definitionValidation.errors)).toBe(true);
    } finally {
      await close();
    }
  });
});

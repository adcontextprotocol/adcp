/**
 * Regression tests for the four sub-bugs fixed in PR #7228 (branch mumbai-v6):
 *
 *   1A  recordsFor uses hardcoded HOUR_MS step regardless of period_duration;
 *       expected_at also hardcoded to +HOUR_MS instead of +delivery_sla.
 *   1B  health:'complete' set as soon as any revision receipt is accepted,
 *       without also checking adjustment receipts for consumer_receipt mode.
 *   2   Legacy getReportingStatus handler cast strips changes_after at the
 *       TypeScript boundary (req typed as old SDK GetReportingStatusRequest).
 *   3   Checkpoint fingerprint is order-dependent: unsorted delivery_config_ids,
 *       media_buy_ids, feed_purposes, and finality arrays; same bug in
 *       validateReportingConfigurationReplacement's immutableConfig comparison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearReportingReliabilityStore,
  replaceReportingConfigurations,
  getReportingStatusForAccount,
  syncReliableReportingReceiptsForAccount,
  prepareReportingCoreLifecycleProbe,
  publishZeroRowReportingCoreLifecycleProbe,
  publishReportingCoreLifecycleProbeRows,
  setReportingCoreLifecycleProbeClock,
  prepareReliableReportingReconciledBillingProbe,
  publishReliableReportingReconciledAdjustments,
  TRAINING_REPORTING_MANAGED_OFFERING,
  TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING,
  type TrainingGetReportingStatusRequest,
  type TrainingGetReportingStatusResponse,
  withDurableReportingLedger,
  nextExpectedAtForSchedule,
  clearReportingAccountBindingCacheForTesting,
  rehydrateReportingLedgerForTesting,
  probeReportingSourceCalendarDst,
  beginReportingRevisionReadTraceForTesting,
  reportingRevisionReadTraceForTesting,
  duplicateCoreRevisionContentForTesting,
} from '../../src/training-agent/reporting-reliability.js';
import { SYNC_REPORTING_RECEIPTS_SCHEMA } from '../../src/training-agent/tenants/sales.js';
import { handleGetMediaBuyDelivery } from '../../src/training-agent/task-handlers.js';
import { legacyGetReportingStatusHandler } from '../../src/training-agent/v6-sales-platform.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { canonicalize } from '@adcp/sdk';
import { createHash } from 'node:crypto';

describe('Reliable Reporting pipeline – PR #7228 regression suite', () => {
  beforeEach(() => {
    clearReportingReliabilityStore();
  });

  it('test-only receipt input projection rejects malformed and combined-overflow batches', () => {
    const base = { account: { account_id: 'acct-receipt-shape' }, idempotency_key: 'receipt-shape-idempotency-key' };
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({ ...base, receipts: [{ arbitrary: true }] }).success).toBe(false);
    const receipt = {
      reporting_receipt_id: 'receipt-shape-001', reporting_obligation_id: 'obligation-shape-001', reporting_revision_id: 'revision-shape-001', reporting_materialization_id: 'materialization-shape-001',
      status: 'accepted', verification_profile: 'native_commit', observed_row_count: 0, observed_control_totals: [], observed_native_version_ref: 'native-v1', observed_at: '2026-08-27T04:01:00.000Z',
    };
    const adjustment = { reporting_receipt_id: 'adjustment-shape-001', reporting_adjustment_id: 'adjustment-shape-001', adjusts_reporting_revision_id: 'revision-shape-001', status: 'accepted', observed_adjustment_sha256: 'a'.repeat(64), observed_at: '2026-08-27T04:01:00.000Z' };
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({ ...base }).success).toBe(false);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({ ...base, receipts: Array.from({ length: 50 }, (_, index) => ({ ...receipt, reporting_receipt_id: `receipt-shape-${index}` })), adjustment_receipts: Array.from({ length: 51 }, (_, index) => ({ ...adjustment, reporting_receipt_id: `adjustment-shape-${index}` })) }).success).toBe(false);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({
      ...base,
      receipts: [{ ...receipt, reporting_receipt_id: 'receipt-shape-rejected', status: 'rejected', rejection_codes: ['DIGEST_MISMATCH'], consumer_commit_ref: 'consumer-commit-1' }],
      adjustment_receipts: [{ ...adjustment, reporting_receipt_id: 'adjustment-shape-rejected', status: 'rejected', rejection_codes: ['TOTAL_MISMATCH'] }],
    }).success).toBe(true);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({
      ...base,
      receipts: [{ ...receipt, verification_profile: 'canonical_digest' }],
    }).success).toBe(false);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({
      ...base,
      receipts: [{ ...receipt, status: 'rejected', rejection_codes: ['DIGEST_MISMATCH', 'DIGEST_MISMATCH'] }],
    }).success).toBe(false);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({
      ...base,
      adjustment_receipts: [{ ...adjustment, rejection_codes: ['TOTAL_MISMATCH'] }],
    }).success).toBe(false);
    expect(SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse({
      ...base,
      adjustment_receipts: [{ ...adjustment, reporting_revision_id: 'not-permitted-on-adjustment-receipts' }],
    }).success).toBe(false);
  });

  it('keeps the direct receipt Zod projection in source-schema parity', () => {
    const base = { account: { account_id: 'acct-receipt-parity' }, idempotency_key: 'receipt-parity-idempotency-key' };
    const validReceipt = {
      reporting_receipt_id: 'receipt-parity-valid-001', reporting_obligation_id: 'obligation-parity-001', reporting_revision_id: 'revision-parity-001', reporting_materialization_id: 'materialization-parity-001',
      status: 'accepted', verification_profile: 'canonical_digest', observed_row_count: 1,
      observed_control_totals: [{ name: 'impressions', value: '1', value_type: 'integer', unit: 'impressions' }],
      observed_canonical_content_digest: { algorithm: 'sha256', value: 'a'.repeat(64), canonicalization_id: 'billing-rows-v1', canonicalization_uri: 'https://billing.example/reporting/canonicalization/v1.json', canonicalization_sha256: 'b'.repeat(64) },
      observed_at: '2026-08-27T04:01:00.000Z',
    };
    const cases: Array<{ name: string; request: Record<string, unknown>; valid: boolean }> = [
      { name: 'valid canonical receipt', request: { ...base, receipts: [validReceipt] }, valid: true },
      { name: 'valid offset accepted receipt', request: { ...base, receipts: [{ ...validReceipt, observed_at: '2026-08-27T05:01:00+01:00' }] }, valid: true },
      { name: 'valid offset accepted adjustment receipt', request: { ...base, adjustment_receipts: [{ reporting_receipt_id: 'adjustment-parity-valid-001', reporting_adjustment_id: 'adjustment-parity-001', adjusts_reporting_revision_id: 'revision-parity-001', status: 'accepted', observed_adjustment_sha256: 'c'.repeat(64), observed_at: '2026-08-27T05:01:00+01:00' }] }, valid: true },
      { name: 'invalid observed_at is rejected', request: { ...base, receipts: [{ ...validReceipt, observed_at: '2026-08-27T25:01:00+01:00' }] }, valid: false },
      { name: 'accepted duplicate control totals', request: { ...base, receipts: [{ ...validReceipt, observed_control_totals: [validReceipt.observed_control_totals[0], validReceipt.observed_control_totals[0]] }] }, valid: false },
      { name: 'rejected duplicate control totals', request: { ...base, receipts: [{ ...validReceipt, status: 'rejected', rejection_codes: ['TOTAL_MISMATCH'], observed_control_totals: [validReceipt.observed_control_totals[0], validReceipt.observed_control_totals[0]] }] }, valid: false },
      { name: 'noncanonical integer', request: { ...base, receipts: [{ ...validReceipt, observed_control_totals: [{ name: 'impressions', value: '01', value_type: 'integer', unit: 'impressions' }] }] }, valid: false },
      { name: 'slash receipt id', request: { ...base, receipts: [{ ...validReceipt, reporting_receipt_id: 'receipt/parity-invalid-001' }] }, valid: false },
      { name: 'insecure canonicalization uri', request: { ...base, receipts: [{ ...validReceipt, observed_canonical_content_digest: { ...validReceipt.observed_canonical_content_digest, canonicalization_uri: 'http://localhost/canonicalization.json' } }] }, valid: false },
    ];
    for (const testCase of cases) {
      const zodValid = SYNC_REPORTING_RECEIPTS_SCHEMA.safeParse(testCase.request).success;
      const sourceValid = validateSourceSchema('media-buy/sync-reporting-receipts-request.json', testCase.request).valid;
      expect(zodValid, testCase.name).toBe(testCase.valid);
      expect(sourceValid, testCase.name).toBe(testCase.valid);
      expect(zodValid, `${testCase.name} parity`).toBe(sourceValid);
    }
  });

  it('uses the fixed Core exact-read JCS vector independently and detects a mutated row', () => {
    // This byte string is a test vector, not a value produced by the handler,
    // controller, or SDK canonicalizer. It is the RFC 8785/JCS binding carried
    // literally by reporting-core.yaml's two-page conformance walk.
    const fixedJcsBinding = '{"control_totals":[{"name":"impressions","unit":"impressions","value":"5","value_type":"integer"}],"reporting_revision_id":"reporting-revision.ecc62efa00946aa1e2788ad9","reporting_rows":[{"dimensions":{"country":"US","media_buy_id":"media-buy-core-001","package_id":"package-core-001"},"impressions":2,"metrics":{"clicks":1,"impressions":2},"period_end":"2026-08-01T01:00:00.000Z","period_start":"2026-08-01T00:00:00.000Z"},{"dimensions":{"country":"CA","media_buy_id":"media-buy-core-002","package_id":"package-core-002"},"impressions":3,"metrics":{"clicks":0,"impressions":3},"period_end":"2026-08-01T01:00:00.000Z","period_start":"2026-08-01T00:00:00.000Z"}],"row_count":2}';
    const expectedDigest = '5199a776b3a99915f084e16c921b2e501fcedd949017236d51a2303c5c2f5cd1';
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(sha256(fixedJcsBinding)).toBe(expectedDigest);

    const mutatedPeriod = fixedJcsBinding.replace(
      '"period_end":"2026-08-01T01:00:00.000Z"',
      '"period_end":"2026-08-01T01:00:01.000Z"',
    );
    expect(sha256(mutatedPeriod)).not.toBe(expectedDigest);
  });

  it('paginates the complete revision resource union with an accurate count', () => {
    const principal = 'test-pr7228-revision-pages';
    const accountId = 'acct-revision-pages';
    const probe = prepareReliableReportingReconciledBillingProbe(principal, accountId);
    const { adjustments } = publishReliableReportingReconciledAdjustments(principal, accountId);
    const first = getReportingStatusForAccount({ view: 'revision', reporting_revision_id: probe.reporting_revision_id, pagination: { max_results: 1 } } as TrainingGetReportingStatusRequest, principal, accountId);
    expect(first.pagination?.total_count).toBeGreaterThan(1);
    expect(first.pagination?.has_more).toBe(true);
    // A correction receipt landing while this cursor is being consumed must not alter
    // the already-issued resource list, snapshot ID, as-of instant, or count.
    const adjustment = adjustments[0]!;
    syncReliableReportingReceiptsForAccount({ adjustment_receipts: [{
      reporting_receipt_id: 'rcpt-page-snapshot-adjustment-001',
      reporting_adjustment_id: adjustment.reporting_adjustment_id,
      adjusts_reporting_revision_id: adjustment.adjusts_reporting_revision_id,
      status: 'accepted',
      observed_adjustment_sha256: adjustment.canonical_adjustment_sha256!,
      observed_at: '2026-08-29T11:00:00.000Z',
    }] }, principal, accountId);
    const second = getReportingStatusForAccount({ view: 'revision', reporting_revision_id: probe.reporting_revision_id, pagination: { max_results: 1, cursor: first.pagination?.cursor } } as TrainingGetReportingStatusRequest, principal, accountId);
    expect(second.status).toBe('completed');
    expect(second.ledger_snapshot_id).toBe(first.ledger_snapshot_id);
    expect(second.ledger_as_of).toBe(first.ledger_as_of);
    expect(second.pagination?.total_count).toBe(first.pagination?.total_count);
  });

  it('retrieves retained zero-row Core content by exact revision identity without changing legacy reads', async () => {
    const principal = 'test-pr7228-exact-revision';
    const accountId = 'acct-exact-revision';
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const published = publishZeroRowReportingCoreLifecycleProbe(principal, accountId);
    const response = await handleGetMediaBuyDelivery({
      account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id,
    }, { mode: 'training', principal, resolvedAccountId: accountId, servedAdcpVersion: '3.2-rc.1' });
    expect(response).toMatchObject({
      reporting_period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
      media_buy_deliveries: [],
      reporting_revision_binding: { reporting_revision_id: published.reporting_revision_id, row_count: 0 },
      reporting_revision: { reporting_revision_id: published.reporting_revision_id, row_count: 0 },
      reporting_rows: [],
    });
    for (const field of ['reporting_revision', 'reporting_revision_binding', 'reporting_rows', 'pagination']) {
      expect(response, `exact response includes ${field}`).toHaveProperty(field);
    }
    const schemaValidation = validateSourceSchema('media-buy/get-media-buy-delivery-response.json', { status: 'completed', ...response });
    expect(schemaValidation.valid, JSON.stringify(schemaValidation.errors)).toBe(true);
    for (const omitted of ['reporting_revision', 'reporting_revision_binding', 'reporting_rows', 'pagination']) {
      const incomplete = { status: 'completed', ...response } as Record<string, unknown>;
      delete incomplete[omitted];
      expect(validateSourceSchema('media-buy/get-media-buy-delivery-response.json', incomplete).valid, `exact quartet requires ${omitted}`).toBe(false);
    }
    expect(validateSourceSchema('media-buy/get-media-buy-delivery-request.json', {
      account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, start_date: '2026-08-01',
    }).valid).toBe(false);
    expect(validateSourceSchema('media-buy/get-media-buy-delivery-request.json', {
      account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, pagination: { max_results: 1 },
    }).valid).toBe(true);
    const rc0 = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id }, { mode: 'training', principal, resolvedAccountId: accountId, servedAdcpVersion: '3.2-rc.0' });
    expect(rc0).toMatchObject({ errors: [{ code: 'VERSION_UNSUPPORTED' }] });
  });

  it('projects the frozen RC0 status wire and accepts RC1-only delta fields only at RC1', async () => {
    const principal = 'test-pr7228-rc0-status';
    const accountId = 'acct-rc0-status';
    const account = { account_id: accountId };
    prepareReportingCoreLifecycleProbe(principal, accountId);
    publishZeroRowReportingCoreLifecycleProbe(principal, accountId);
    // Cache the natural account binding exactly as a durable sync_accounts
    // write would, allowing the SDK handler to use the normal resolver.
    await withDurableReportingLedger(principal, accountId, true, () => undefined, account);
    const handler = legacyGetReportingStatusHandler();
    const context = { authInfo: { clientId: principal }, account: undefined };
    const rc0 = await handler({ account, view: 'periods', adcp_version: '3.2-rc.0' } as never, context as never) as Record<string, unknown>;
    expect(rc0).not.toHaveProperty('changes_checkpoint');
    expect(rc0).not.toHaveProperty('adjustments');
    expect(rc0).not.toHaveProperty('adjustment_receipts');
    await expect(handler({ account, view: 'periods', changes_after: 'reporting_change_1_deadbeefdeadbeef', adcp_version: '3.2-rc.0' } as never, context as never))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const rc1 = await handler({ account, view: 'periods', adcp_version: '3.2-rc.1' } as never, context as never) as Record<string, unknown>;
    expect(rc1).toHaveProperty('changes_checkpoint');
    expect(rc1).toHaveProperty('adjustments');
  });

  it('hydrates exact reads from a durable natural account reference after cache loss', async () => {
    const principal = 'test-pr7228-natural-account';
    const accountId = 'acct-natural-account';
    const naturalAccount = { brand: { domain: 'exact-reader.example' }, operator: 'pinnacle-agency.example', sandbox: true };
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const published = publishZeroRowReportingCoreLifecycleProbe(principal, accountId);
    await withDurableReportingLedger(principal, accountId, true, () => undefined, naturalAccount);
    clearReportingAccountBindingCacheForTesting();
    const read = await handleGetMediaBuyDelivery({ account: naturalAccount, reporting_revision_id: published.reporting_revision_id }, {
      mode: 'training', principal, servedAdcpVersion: '3.2-rc.1',
    });
    expect(read).toMatchObject({ reporting_revision: { reporting_revision_id: published.reporting_revision_id } });
    const omittedAccount = await handleGetMediaBuyDelivery({ reporting_revision_id: published.reporting_revision_id }, {
      mode: 'training', principal, servedAdcpVersion: '3.2-rc.1', resolvedAccountId: 'synthetic_wrong_context',
    });
    expect(omittedAccount).toMatchObject({ reporting_revision: { reporting_revision_id: published.reporting_revision_id } });
    const opaque = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id }, {
      mode: 'training', principal, servedAdcpVersion: '3.2-rc.1', resolvedAccountId: 'synthetic_wrong_context',
    });
    expect(opaque).toMatchObject({ reporting_revision: { reporting_revision_id: published.reporting_revision_id } });
    const unauthorized = await handleGetMediaBuyDelivery({ account: naturalAccount, reporting_revision_id: published.reporting_revision_id }, {
      mode: 'training', principal: 'other-consumer', servedAdcpVersion: '3.2-rc.1',
    });
    expect(unauthorized).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
  });

  it('uses read-only omitted-account probes before persisting exactly one matching cursor owner', async () => {
    const principal = 'test-pr7228-omitted-account-probe';
    const accounts = [
      { accountId: 'acct-readonly-probe-a', account: { brand: { domain: 'probe-a.example' }, operator: 'pinnacle-agency.example', sandbox: true } },
      { accountId: 'acct-readonly-probe-owner', account: { brand: { domain: 'probe-owner.example' }, operator: 'pinnacle-agency.example', sandbox: true } },
      { accountId: 'acct-readonly-probe-c', account: { brand: { domain: 'probe-c.example' }, operator: 'pinnacle-agency.example', sandbox: true } },
    ];
    for (const candidate of accounts) {
      prepareReportingCoreLifecycleProbe(principal, candidate.accountId);
      await withDurableReportingLedger(principal, candidate.accountId, true, () => undefined, candidate.account);
    }
    const owner = accounts[1];
    const published = publishReportingCoreLifecycleProbeRows(principal, owner.accountId, [
      { period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-08-01T01:00:00.000Z', impressions: 1 },
      { period_start: '2026-08-01T01:00:00.000Z', period_end: '2026-08-01T02:00:00.000Z', impressions: 2 },
    ]);
    const context = { mode: 'training' as const, principal, servedAdcpVersion: '3.2-rc.1' as const };
    const expectedProbeIds = accounts.map(candidate => candidate.accountId).sort();
    const expectProbeSet = (alsoPersistedOwner: boolean) => {
      const trace = reportingRevisionReadTraceForTesting();
      expect(trace.filter(entry => entry.kind === 'existence_probe').map(entry => entry.accountId).sort())
        .toEqual(expectedProbeIds);
      expect(trace.filter(entry => entry.kind === 'persisting_page_read')).toEqual(
        alsoPersistedOwner ? [{ kind: 'persisting_page_read', accountId: owner.accountId }] : [],
      );
    };
    clearReportingAccountBindingCacheForTesting();
    beginReportingRevisionReadTraceForTesting();
    const first = await handleGetMediaBuyDelivery({
      reporting_revision_id: published.reporting_revision_id,
      pagination: { max_results: 1 },
    }, context);
    expect(first).toMatchObject({ reporting_rows: [{ impressions: 1 }], pagination: { has_more: true, total_count: 2 } });
    expectProbeSet(true);

    // A durable JSON/cache-loss boundary preserves page two. It probes every
    // accessible candidate read-only again, then writes only the known owner.
    rehydrateReportingLedgerForTesting(principal, owner.accountId);
    clearReportingAccountBindingCacheForTesting();
    beginReportingRevisionReadTraceForTesting();
    const second = await handleGetMediaBuyDelivery({
      reporting_revision_id: published.reporting_revision_id,
      pagination: { max_results: 1, cursor: (first.pagination as { cursor: string }).cursor },
    }, context);
    expect(second).toMatchObject({ reporting_rows: [{ impressions: 2 }], pagination: { has_more: false, total_count: 2 } });
    expectProbeSet(true);

    beginReportingRevisionReadTraceForTesting();
    const missing = await handleGetMediaBuyDelivery({ reporting_revision_id: 'reporting-revision.no-such-owner' }, context);
    expect(missing).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
    expectProbeSet(false);

    // A corrupted duplicate is not resolved to either account, and the error
    // stays identical to an ordinary unknown ID rather than exposing owners.
    duplicateCoreRevisionContentForTesting(principal, owner.accountId, accounts[2].accountId, published.reporting_revision_id);
    beginReportingRevisionReadTraceForTesting();
    const ambiguous = await handleGetMediaBuyDelivery({ reporting_revision_id: published.reporting_revision_id }, context);
    expect(ambiguous).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
    expectProbeSet(false);

    // Supplying an account preserves the existing direct write-locking path:
    // no discovery probes are needed and only that ledger persists a cursor.
    beginReportingRevisionReadTraceForTesting();
    const explicit = await handleGetMediaBuyDelivery({
      account: owner.account,
      reporting_revision_id: published.reporting_revision_id,
      pagination: { max_results: 1 },
    }, context);
    expect(explicit).toMatchObject({ reporting_rows: [{ impressions: 1 }] });
    expect(reportingRevisionReadTraceForTesting()).toEqual([
      { kind: 'persisting_page_read', accountId: owner.accountId },
    ]);
  });

  it('pins exact-read cursor pages to immutable metadata and ordered rows', async () => {
    const principal = 'test-pr7228-nonempty-revision';
    const accountId = 'acct-nonempty-revision';
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const rows = [
      { period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-08-01T01:00:00.000Z', impressions: 7 },
      { period_start: '2026-08-01T01:00:00.000Z', period_end: '2026-08-01T02:00:00.000Z', impressions: 3 },
    ];
    const published = publishReportingCoreLifecycleProbeRows(principal, accountId, rows);
    const status = getReportingStatusForAccount({ view: 'revision', reporting_revision_id: published.reporting_revision_id } as TrainingGetReportingStatusRequest, principal, accountId);
    const read = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, pagination: { max_results: 1 } }, { mode: 'training', principal, resolvedAccountId: accountId, servedAdcpVersion: '3.2-rc.1' });
    expect(read).toMatchObject({ reporting_rows: [{ impressions: 7 }], reporting_revision: { revision_content_sha256: published.revision_content_sha256 }, reporting_revision_binding: { content_sha256: published.revision_content_sha256 }, pagination: { total_count: 2, has_more: true } });
    const next = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, pagination: { max_results: 1, cursor: (read.pagination as { cursor: string }).cursor } }, { mode: 'training', principal, resolvedAccountId: accountId, servedAdcpVersion: '3.2-rc.1' });
    expect(next).toMatchObject({ reporting_rows: [{ impressions: 3 }], reporting_revision: read.reporting_revision, reporting_revision_binding: read.reporting_revision_binding, pagination: { total_count: 2, has_more: false } });
    expect((status.revision as Record<string, unknown>).revision_content_sha256).toBe(published.revision_content_sha256);
    expect((read.reporting_revision_binding as Record<string, unknown>).content_sha256).toBe(createHash('sha256').update(canonicalize({
      reporting_revision_id: published.reporting_revision_id, row_count: 2,
      control_totals: [{ name: 'impressions', value: '10', value_type: 'integer', unit: 'impressions' }],
      reporting_rows: rows,
    })).digest('hex'));
    const mixed = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, include_package_daily_breakdown: false }, { mode: 'training', principal, resolvedAccountId: accountId, servedAdcpVersion: '3.2-rc.1' });
    expect(mixed).toMatchObject({ errors: [{ code: 'VALIDATION_ERROR' }] });
    const cursor = (read.pagination as { cursor: string }).cursor;
    const tampered = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, pagination: { cursor: `${cursor}x` } }, { mode: 'training', principal, servedAdcpVersion: '3.2-rc.1' });
    expect(tampered).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
    const wrongPrincipal = await handleGetMediaBuyDelivery({ account: { account_id: accountId }, reporting_revision_id: published.reporting_revision_id, pagination: { cursor } }, { mode: 'training', principal: 'other-principal', servedAdcpVersion: '3.2-rc.1' });
    expect(wrongPrincipal).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
    expect(validateSourceSchema('media-buy/get-media-buy-delivery-request.json', { pagination: { max_results: 1 } }).valid).toBe(false);
  });

  it('retains exact cursor snapshots across durable-ledger rehydration and rejects account/revision swaps', async () => {
    const principal = 'test-pr7228-exact-cursor-rehydration';
    const accountId = 'acct-exact-cursor-rehydration';
    const naturalAccount = { brand: { domain: 'cursor-reader.example' }, operator: 'pinnacle-agency.example', sandbox: true };
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const published = publishReportingCoreLifecycleProbeRows(principal, accountId, [
      { period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-08-01T01:00:00.000Z', impressions: 1 },
      { period_start: '2026-08-01T01:00:00.000Z', period_end: '2026-08-01T02:00:00.000Z', impressions: 2 },
    ]);
    await withDurableReportingLedger(principal, accountId, true, () => undefined, naturalAccount);
    const context = { mode: 'training' as const, principal, servedAdcpVersion: '3.2-rc.1' as const };
    const first = await handleGetMediaBuyDelivery({
      account: naturalAccount, reporting_revision_id: published.reporting_revision_id, pagination: { max_results: 1 },
    }, context);
    const cursor = (first.pagination as { cursor: string }).cursor;
    // This is the JSON round-trip used by DB reload; discard the account
    // resolver cache as well so page two relies solely on durable ledger state.
    rehydrateReportingLedgerForTesting(principal, accountId);
    clearReportingAccountBindingCacheForTesting();
    const second = await handleGetMediaBuyDelivery({
      account: naturalAccount, reporting_revision_id: published.reporting_revision_id, pagination: { max_results: 1, cursor },
    }, context);
    expect(second).toMatchObject({ reporting_rows: [{ impressions: 2 }], pagination: { has_more: false, total_count: 2 } });
    const accountSwap = await handleGetMediaBuyDelivery({
      account: { account_id: 'acct-other-cursor-account' }, reporting_revision_id: published.reporting_revision_id, pagination: { cursor },
    }, context);
    expect(accountSwap).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
    const revisionSwap = await handleGetMediaBuyDelivery({
      account: naturalAccount, reporting_revision_id: 'reporting-revision.other', pagination: { cursor },
    }, context);
    expect(revisionSwap).toMatchObject({ errors: [{ code: 'REPORTING_REVISION_NOT_FOUND' }] });
  });

  it('makes revision-content publication idempotent only for byte-identical metadata and bindings', () => {
    const principal = 'test-pr7228-revision-immutability';
    const accountId = 'acct-revision-immutability';
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const rows = [{ period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-08-01T01:00:00.000Z', impressions: 1 }];
    const first = publishReportingCoreLifecycleProbeRows(principal, accountId, rows);
    expect(publishReportingCoreLifecycleProbeRows(principal, accountId, rows)).toMatchObject(first);
    expect(() => publishReportingCoreLifecycleProbeRows(principal, accountId, [{ ...rows[0], impressions: 2 }]))
      .toThrow(/Immutable reporting revision/);
    setReportingCoreLifecycleProbeClock(principal, accountId, '2026-08-01T03:00:00.000Z');
    expect(() => publishReportingCoreLifecycleProbeRows(principal, accountId, rows))
      .toThrow(/Immutable reporting revision/);
    expect(() => publishReportingCoreLifecycleProbeRows(principal, accountId, rows, {
      control_totals: [{ name: 'impressions', value: '999', value_type: 'integer', unit: 'impressions' }],
    })).toThrow(/Immutable reporting revision/);
  });

  // ---------------------------------------------------------------------------
  // Bug 1A: daily offering must generate one P1D obligation per day, not 24
  // ---------------------------------------------------------------------------
  it('daily (P1D) offering generates one obligation per calendar day, not 24 hourly ones', () => {
    const principal = 'test-pr7228-1a';
    const accountId = 'acct-1a';

    // Construct a valid analytics-daily-managed config. schema requires method +
    // destination when the offering advertises one.
    const dailyConfig = {
      delivery_config_id: 'test-daily-analytics',
      delivery_config_version: 1,
      offering_id: TRAINING_REPORTING_MANAGED_OFFERING.offering_id,        // 'analytics-daily-managed'
      active: true,
      feed_purpose: TRAINING_REPORTING_MANAGED_OFFERING.feed_purpose,       // 'analytics'
      report_definition_id: TRAINING_REPORTING_MANAGED_OFFERING.report_definition_id,
      reporting_profile: TRAINING_REPORTING_MANAGED_OFFERING.reporting_profile.id,
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: TRAINING_REPORTING_MANAGED_OFFERING.schedule,               // period_duration: 'P1D', delivery_sla: 'PT4H'
      method: {
        pattern: TRAINING_REPORTING_MANAGED_OFFERING.method.pattern,        // 'dataset_share'
        transport: TRAINING_REPORTING_MANAGED_OFFERING.method.transport,    // 'training_dataset'
        orchestration: TRAINING_REPORTING_MANAGED_OFFERING.method.orchestration, // 'producer_managed'
        destination: {
          mode: 'provision',
          provider: { domain: TRAINING_REPORTING_MANAGED_OFFERING.method.provider.domain },
          access_mode: TRAINING_REPORTING_MANAGED_OFFERING.method.access_mode,   // 'read_only'
          recipient: { identity: 'test-reporting-consumer-1a' },
        },
      },
    };

    const activatedAt = '2026-09-01T00:00:00.000Z';
    replaceReportingConfigurations(principal, accountId, [dailyConfig], activatedAt);
    // 2026-09-04T10:00Z is ~3.4 days after activation; setReportingCoreLifecycleProbeClock
    // sets ledger.virtualNow without requiring the core lifecycle probe's exact fixture.
    setReportingCoreLifecycleProbeClock(principal, accountId, '2026-09-04T10:00:00.000Z');

    const response = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    expect(response.status).toBe('completed');
    const periods = response.periods ?? [];

    // Before fix: step = HOUR_MS → ~80 hourly obligations for the same window.
    // After fix:  step = 24 * HOUR_MS → one obligation per day.
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.length).toBeLessThan(5);

    for (const period of periods) {
      const durationMs = Date.parse(period.period.end) - Date.parse(period.period.start);
      // Each obligation must span exactly 24 h (86 400 000 ms).
      expect(durationMs).toBe(86_400_000);
    }
    expect(response.next_expected_at).toBe('2026-09-05T04:00:00.000Z');

    // Retention never emits a partial daily period: the first retained daily
    // boundary remains readable, while a period beginning before it is an
    // explicit nondisclosing history miss.
    setReportingCoreLifecycleProbeClock(principal, accountId, '2026-10-10T10:00:00.000Z');
    expect(getReportingStatusForAccount({
      view: 'periods', period: { start: '2026-09-10T00:00:00.000Z', end: '2026-09-11T00:00:00.000Z' },
    } as TrainingGetReportingStatusRequest, principal, accountId).status).toBe('completed');
    expect(getReportingStatusForAccount({
      view: 'periods', period: { start: '2026-09-09T00:00:00.000Z', end: '2026-09-10T00:00:00.000Z' },
    } as TrainingGetReportingStatusRequest, principal, accountId).status).toBe('failed');
  });

  it('runs the real installed source-calendar scheduler through both 2026 DST transitions', () => {
    const result = probeReportingSourceCalendarDst('test-pr7228-dst-controller', 'acct-dst-controller');
    expect(result.fall_back).toEqual({
      start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z', expected_at: '2026-11-02T09:00:00.000Z',
    });
    expect(result.spring_forward).toEqual({
      start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z', expected_at: '2026-03-09T08:00:00.000Z',
    });
  });

  it('derives daily next_expected_at from IANA civil time across DST changes', () => {
    const schedule = { period_duration: 'P1D' as const, alignment: 'source_timezone' as const, period_timezone: 'America/New_York', delivery_sla: 'PT4H' as const };
    expect(nextExpectedAtForSchedule(schedule, '2026-03-08T07:30:00.000Z')).toBe('2026-03-08T08:00:00.000Z');
    expect(nextExpectedAtForSchedule(schedule, '2026-03-08T08:30:00.000Z')).toBe('2026-03-09T08:00:00.000Z');
    expect(nextExpectedAtForSchedule(schedule, '2026-11-01T08:30:00.000Z')).toBe('2026-11-01T09:00:00.000Z');
  });

  it('generates real source-calendar daily periods and deadlines across DST', () => {
    const configFor = (recipient: string) => ({
      delivery_config_id: `source-calendar-${recipient}`,
      delivery_config_version: 1,
      offering_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.offering_id,
      active: true,
      feed_purpose: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.feed_purpose,
      report_definition_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.report_definition_id,
      reporting_profile: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.reporting_profile.id,
      scope: { all_media_buys: true }, coverage_requirement: 'full', required_finality: 'official', reconciliation_mode: 'delivery_only',
      schedule: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.schedule,
      method: {
        pattern: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.pattern,
        transport: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.transport,
        orchestration: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.orchestration,
        destination: { mode: 'provision', provider: { domain: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.provider.domain }, access_mode: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.access_mode, recipient: { identity: recipient } },
      },
    });
    const fallPrincipal = 'test-pr7228-source-calendar-fall';
    const fallAccount = 'acct-source-calendar-fall';
    replaceReportingConfigurations(fallPrincipal, fallAccount, [configFor('source-calendar-fall')], '2026-10-30T04:00:00.000Z');
    setReportingCoreLifecycleProbeClock(fallPrincipal, fallAccount, '2026-11-03T12:00:00.000Z');
    const fall = getReportingStatusForAccount({ view: 'periods' } as TrainingGetReportingStatusRequest, fallPrincipal, fallAccount);
    const fallbackDay = fall.periods?.find(period => period.period.start === '2026-11-01T04:00:00.000Z');
    expect(fallbackDay).toMatchObject({ period: { end: '2026-11-02T05:00:00.000Z' }, expected_at: '2026-11-02T09:00:00.000Z' });

    const springPrincipal = 'test-pr7228-source-calendar-spring';
    const springAccount = 'acct-source-calendar-spring';
    replaceReportingConfigurations(springPrincipal, springAccount, [configFor('source-calendar-spring')], '2026-03-06T05:00:00.000Z');
    setReportingCoreLifecycleProbeClock(springPrincipal, springAccount, '2026-03-10T12:00:00.000Z');
    const spring = getReportingStatusForAccount({ view: 'periods' } as TrainingGetReportingStatusRequest, springPrincipal, springAccount);
    const springForwardDay = spring.periods?.find(period => period.period.start === '2026-03-08T05:00:00.000Z');
    expect(springForwardDay).toMatchObject({ period: { end: '2026-03-09T04:00:00.000Z' }, expected_at: '2026-03-09T08:00:00.000Z' });
  });

  // ---------------------------------------------------------------------------
  // Bug 1B: reconciled billing health must not be 'complete' until both
  // revision receipts AND adjustment receipts are accepted
  // ---------------------------------------------------------------------------
  it('reconciled billing health stays non-complete until adjustment receipts are accepted', () => {
    const principal = 'test-pr7228-1b';
    const accountId = 'acct-1b';

    const probe = prepareReliableReportingReconciledBillingProbe(principal, accountId);

    // Submit an accepted revision receipt. The canonical_digest verification data
    // is taken directly from the probe fixture (row_count=2, canonical SHA present).
    syncReliableReportingReceiptsForAccount(
      {
        receipts: [{
          reporting_receipt_id: 'rcpt-1b-revision-001',
          reporting_obligation_id: probe.reporting_obligation_id,
          reporting_revision_id: probe.reporting_revision_id,
          reporting_materialization_id: probe.reporting_materialization_id,
          status: 'accepted',
          verification_profile: 'canonical_digest',
          observed_row_count: 2,
          observed_control_totals: [
            { name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' },
            { name: 'spend', value: '8.00', value_type: 'decimal', unit: 'USD' },
          ],
          observed_canonical_content_digest: probe.canonical_content_digest,
          observed_at: '2026-08-27T04:01:00.000Z',
        }],
      },
      principal,
      accountId,
    );

    const afterRevision = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    // An accepted revision receipt completes a clean close with no applicable
    // adjustments; its zero adjustment counts are part of the wire contract.
    const periodsAfterRevision = afterRevision.periods ?? [];
    expect(periodsAfterRevision).toEqual(expect.arrayContaining([
      expect.objectContaining({
        health: 'complete',
        adjustment_count: 0,
        adjustment_receipt_count: 0,
        accepted_adjustment_receipt_count: 0,
      }),
    ]));

    const { adjustments } = publishReliableReportingReconciledAdjustments(principal, accountId);

    // Every applicable adjustment must be accepted; one accepted adjustment
    // cannot complete the obligation while another remains pending.
    const acceptedAdj = adjustments.find(a => a.reason_code === 'invalid_traffic')!;
    syncReliableReportingReceiptsForAccount(
      {
        adjustment_receipts: [{
          reporting_receipt_id: 'rcpt-1b-adjustment-001',
          reporting_adjustment_id: acceptedAdj.reporting_adjustment_id,
          adjusts_reporting_revision_id: acceptedAdj.adjusts_reporting_revision_id,
          status: 'accepted',
          observed_adjustment_sha256: acceptedAdj.canonical_adjustment_sha256,
          observed_at: '2026-08-29T10:01:00.000Z',
        }],
      },
      principal,
      accountId,
    );

    const afterAdjustment = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    expect((afterAdjustment.periods ?? []).some(p => p.health === 'complete')).toBe(false);
    const remainingAdj = adjustments.find(a => a.reporting_adjustment_id !== acceptedAdj.reporting_adjustment_id)!;
    syncReliableReportingReceiptsForAccount({ adjustment_receipts: [{
      reporting_receipt_id: 'rcpt-1b-adjustment-002', reporting_adjustment_id: remainingAdj.reporting_adjustment_id,
      adjusts_reporting_revision_id: remainingAdj.adjusts_reporting_revision_id, status: 'accepted',
      observed_adjustment_sha256: remainingAdj.canonical_adjustment_sha256, observed_at: '2026-08-29T10:02:00.000Z',
    }] }, principal, accountId);
    expect((getReportingStatusForAccount({ view: 'periods' } as TrainingGetReportingStatusRequest, principal, accountId).periods ?? [])
      .some(period => period.health === 'complete')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Bug 2: changes_after must survive the round-trip through getReportingStatus
  // ---------------------------------------------------------------------------
  it('changes_after token from a completed response is honoured on the next call', () => {
    const principal = 'test-pr7228-2';
    const accountId = 'acct-2';

    // Core lifecycle probe: hourly config, virtualNow = 2026-08-01T01:30 → one
    // complete period [00:00, 01:00) exists.
    prepareReportingCoreLifecycleProbe(principal, accountId);

    const first = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    expect(first.status).toBe('completed');
    const checkpoint = first.changes_checkpoint;
    expect(checkpoint).toMatch(/^reporting_change_\d+_[0-9a-f]{16}$/);

    // A second call with changes_after set to the returned checkpoint must
    // succeed (status: 'completed') rather than return lookup_unavailable.
    const second = getReportingStatusForAccount(
      { view: 'periods', changes_after: checkpoint } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    );

    expect(second.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Bug 3: feed_purposes (and other array filters) in reversed order must
  // produce the same checkpoint fingerprint → changes_after must still be valid
  // ---------------------------------------------------------------------------
  it('feed_purposes in reversed order with a valid changes_after token succeeds', () => {
    const principal = 'test-pr7228-3';
    const accountId = 'acct-3';

    prepareReportingCoreLifecycleProbe(principal, accountId);

    // First request: feed_purposes = ['pacing', 'analytics'] (one order)
    const first = getReportingStatusForAccount(
      { view: 'periods', feed_purposes: ['pacing', 'analytics'] } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    expect(first.status).toBe('completed');
    const checkpoint = first.changes_checkpoint;
    expect(checkpoint).toMatch(/^reporting_change_\d+_[0-9a-f]{16}$/);

    // Second request: same filters but feed_purposes in reversed order + the
    // checkpoint from the first call.
    // Before fix: JSON.stringify(['analytics','pacing']) !== JSON.stringify(['pacing','analytics'])
    //   → different fingerprint → status: 'failed' (lookup_unavailable).
    // After fix:  arrays sorted before stringify → same fingerprint → status: 'completed'.
    const second = getReportingStatusForAccount(
      {
        view: 'periods',
        feed_purposes: ['analytics', 'pacing'],
        changes_after: checkpoint,
      } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    );

    expect(second.status).toBe('completed');
  });

  it('health filters in a different order retain the same checkpoint scope', () => {
    const principal = 'test-pr7228-health-order';
    const accountId = 'acct-health-order';
    prepareReportingCoreLifecycleProbe(principal, accountId);
    const first = getReportingStatusForAccount({ view: 'periods', health: ['waiting', 'complete'] } as TrainingGetReportingStatusRequest, principal, accountId);
    const second = getReportingStatusForAccount({ view: 'periods', health: ['complete', 'waiting'], changes_after: first.changes_checkpoint } as TrainingGetReportingStatusRequest, principal, accountId);
    expect(second.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Bug 4: for daily configs older than RETENTION_DAYS (31 days), the retention
  // cutoff was hour-aligned (floorHour) but not period-aligned (floorPeriod),
  // causing the first visible period to start at an arbitrary hour instead of
  // midnight UTC.
  // ---------------------------------------------------------------------------
  it('daily config older than 31 days: all periods start at midnight UTC', () => {
    const principal = 'test-pr7228-4';
    const accountId = 'acct-4';

    // Activate 40 days in the past so the 31-day retention window is the
    // binding constraint on firstStart, not the activation date.
    const activatedAt = new Date(Date.UTC(2026, 6, 25, 0, 0, 0, 0)).toISOString(); // 2026-07-25T00:00:00.000Z

    const dailyConfig = {
      delivery_config_id: 'test-daily-retention',
      delivery_config_version: 1,
      offering_id: TRAINING_REPORTING_MANAGED_OFFERING.offering_id,
      active: true,
      feed_purpose: TRAINING_REPORTING_MANAGED_OFFERING.feed_purpose,
      report_definition_id: TRAINING_REPORTING_MANAGED_OFFERING.report_definition_id,
      reporting_profile: TRAINING_REPORTING_MANAGED_OFFERING.reporting_profile.id,
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: TRAINING_REPORTING_MANAGED_OFFERING.schedule, // P1D / PT4H
      method: {
        pattern: TRAINING_REPORTING_MANAGED_OFFERING.method.pattern,
        transport: TRAINING_REPORTING_MANAGED_OFFERING.method.transport,
        orchestration: TRAINING_REPORTING_MANAGED_OFFERING.method.orchestration,
        destination: {
          mode: 'provision',
          provider: { domain: TRAINING_REPORTING_MANAGED_OFFERING.method.provider.domain },
          access_mode: TRAINING_REPORTING_MANAGED_OFFERING.method.access_mode,
          recipient: { identity: 'test-reporting-consumer-4' },
        },
      },
    };

    replaceReportingConfigurations(principal, accountId, [dailyConfig], activatedAt);
    // virtualNow: 2026-09-04T10:30:00.000Z — a non-midnight hour so that
    // floorHour(nowMs) - 31*DAY_MS lands at 10:00 UTC (not midnight).
    // Before the fix, firstStart = that 10:00 timestamp, producing periods
    // starting at 10:00, 10:00+24h, … instead of 00:00, 00:00+24h, …
    setReportingCoreLifecycleProbeClock(principal, accountId, '2026-09-04T10:30:00.000Z');

    const response = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;

    expect(response.status).toBe('completed');
    const periods = response.periods ?? [];
    expect(periods.length).toBeGreaterThan(0);

    for (const period of periods) {
      // Every period must start at exactly midnight UTC.
      expect(period.period.start).toMatch(/T00:00:00\.000Z$/);
      // And span exactly 24 hours.
      const durationMs = Date.parse(period.period.end) - Date.parse(period.period.start);
      expect(durationMs).toBe(86_400_000);
    }
    // The oldest whole day overlaps the instant retention horizon and is
    // readable when explicitly requested by its own midnight boundary.
    const oldest = periods[0]!.period;
    expect(getReportingStatusForAccount({ view: 'periods', period: oldest } as TrainingGetReportingStatusRequest, principal, accountId).status).toBe('completed');
  });

  // PR #7254 regression: deactivating a daily config mid-day must not drop the
  // in-progress day's obligation. The cutoff boundary must be the NEXT civil day
  // start (firstCivilDayStartAtOrAfter), not the current day start.
  it('deactivating a daily source-calendar config mid-day still owes that day\'s period', () => {
    const principal = 'test-pr7254-midday-deactivation';
    const accountId = 'acct-midday-deactivation';
    const baseConfig = {
      delivery_config_id: 'midday-deactivation-cfg',
      delivery_config_version: 1,
      offering_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.offering_id,
      active: true,
      feed_purpose: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.feed_purpose,
      report_definition_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.report_definition_id,
      reporting_profile: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.reporting_profile.id,
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.schedule,
      method: {
        pattern: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.pattern,
        transport: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.transport,
        orchestration: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.orchestration,
        destination: { mode: 'provision', provider: { domain: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.provider.domain }, access_mode: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.access_mode, recipient: { identity: 'midday-deactivation-recipient' } },
      },
    };

    // Activate at the start of 2026-09-01 (America/New_York = UTC-4, so 04:00Z).
    replaceReportingConfigurations(principal, accountId, [baseConfig], '2026-09-01T04:00:00.000Z');

    // Deactivate mid-day on 2026-09-03 at 14:00 New York time (18:00Z).
    replaceReportingConfigurations(principal, accountId, [{ ...baseConfig, active: false, revocation_effective_at: '2026-09-03T18:00:00.000Z' }], '2026-09-03T18:00:00.000Z');

    // Advance past the end of 2026-09-03 (midnight New York = 04:00Z on Sep 4).
    // Obligations are committed only after their reporting period has closed.
    setReportingCoreLifecycleProbeClock(principal, accountId, '2026-09-04T04:01:00.000Z');

    const response = getReportingStatusForAccount({
      view: 'periods',
      delivery_config_ids: [baseConfig.delivery_config_id],
    } as TrainingGetReportingStatusRequest, principal, accountId);
    const periods = response.periods ?? [];

    // 2026-09-03 in America/New_York runs from 2026-09-03T04:00:00.000Z to 2026-09-04T04:00:00.000Z.
    // Deactivating at 18:00Z must not erase this period — the day was already in progress.
    const sep3Period = periods.find(p => p.period.start === '2026-09-03T04:00:00.000Z');
    expect(sep3Period).toBeDefined();
    expect(sep3Period?.period.end).toBe('2026-09-04T04:00:00.000Z');

    // 2026-09-04 must NOT appear — deactivation was before that day's start.
    const sep4Period = periods.find(p => p.period.start === '2026-09-04T04:00:00.000Z');
    expect(sep4Period).toBeUndefined();
  });

  // PR #7254 regression: canonicalCoreConfig must (a) reject invalid IANA timezone
  // strings before they crash downstream status reads, and (b) reject a valid IANA
  // timezone that does not match the offering's pinned period_timezone.
  it('source-calendar offering rejects invalid and mismatched period_timezone values', () => {
    const principal = 'test-pr7254-tz-validation';
    const accountId = 'acct-tz-validation';
    const baseConfig = {
      delivery_config_id: 'tz-validation-cfg',
      delivery_config_version: 1,
      offering_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.offering_id,
      active: true,
      feed_purpose: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.feed_purpose,
      report_definition_id: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.report_definition_id,
      reporting_profile: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.reporting_profile.id,
      scope: { all_media_buys: true },
      coverage_requirement: 'full',
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      schedule: {
        ...TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.schedule,
        period_timezone: 'Not/A_Zone',
      },
      method: {
        pattern: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.pattern,
        transport: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.transport,
        orchestration: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.orchestration,
        destination: { mode: 'provision', provider: { domain: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.provider.domain }, access_mode: TRAINING_REPORTING_SOURCE_CALENDAR_OFFERING.method.access_mode, recipient: { identity: 'tz-validation-recipient' } },
      },
    };

    // Invalid IANA timezone must be caught early with a descriptive error.
    expect(() => replaceReportingConfigurations(principal, accountId, [baseConfig], '2026-09-01T04:00:00.000Z'))
      .toThrow(/Invalid IANA timezone/);

    // A valid IANA timezone that doesn't match the offering's pinned zone must also be rejected.
    expect(() => replaceReportingConfigurations(principal, accountId, [{ ...baseConfig, schedule: { ...baseConfig.schedule, period_timezone: 'Asia/Tokyo' } }], '2026-09-01T04:00:00.000Z'))
      .toThrow(/advertised Reliable Reporting offering/);

    // The correct timezone must succeed.
    expect(() => replaceReportingConfigurations(principal, accountId, [{ ...baseConfig, schedule: { ...baseConfig.schedule, period_timezone: 'America/New_York' } }], '2026-09-01T04:00:00.000Z'))
      .not.toThrow();
  });
});

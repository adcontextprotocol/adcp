import { describe, expect, it, beforeEach } from 'vitest';
import { GetReportingStatusResponseSchema } from '@adcp/sdk/schemas';
import {
  advanceReportingCoreLifecycleProbe,
  clearReportingReliabilityStore,
  getReportingStatusForAccount,
  prepareReportingCoreLifecycleProbe,
  prepareReliableReportingCoreIntegrityProbe,
  prepareReliableReportingManagedDeliveryProbe,
  prepareReliableReportingReconciledBillingProbe,
  projectedReportingConfigurationStates,
  publishZeroRowReportingCoreLifecycleProbe,
  publishReliableReportingCoreIntegrityCorrection,
  publishReliableReportingReconciledAdjustments,
  reportingConfigurationStatesForAccount,
  replaceReportingConfigurations,
  setReportingCoreLifecycleProbeClock,
  setReportingMediaBuyCandidates,
  syncReliableReportingReceiptsForAccount,
  TRAINING_REPORTING_CORE_CONFIGURATION,
  TRAINING_REPORTING_MANAGED_OFFERING,
  TRAINING_REPORTING_RECONCILED_OFFERING,
  validateReportingConfigurations,
  validateReliableReportingResponse,
  validateReportingConfigurationScopes,
  updateReliableReportingManagedDeliveryProbe,
} from '../../src/training-agent/reporting-reliability.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';

const ACCOUNT_ID = 'acc_reporting_training';
const BASE_REQUEST = {
  account: { account_id: ACCOUNT_ID },
} as const;

describe('training-agent Core reporting reliability ledger', () => {
  beforeEach(() => clearReportingReliabilityStore());

  it('makes a closed period visible before its first revision, then exposes missing-first-report health deterministically', () => {
    const prepared = prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const waiting = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);

    expect(waiting.status).toBe('completed');
    expect(waiting.view).toBe('periods');
    expect(waiting.periods).toHaveLength(1);
    expect(waiting.periods?.[0]).toMatchObject({
      reporting_obligation_id: prepared.reporting_obligation_id,
      health: 'waiting',
      production_status: 'pending',
      revision_count: 0,
      issues: [],
    });
    expect(waiting.revisions).toEqual([]);
    expect(waiting.scope).toMatchObject({ scope_closed: true });
    expect(waiting).not.toHaveProperty('next_expected_at');
    expect(GetReportingStatusResponseSchema.safeParse(waiting).success).toBe(true);

    advanceReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID, 'delayed');
    const delayed = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'summary' }, 'buyer:alpha', ACCOUNT_ID);
    expect(delayed).toMatchObject({
      status: 'completed',
      health: 'delayed',
      obligation_counts: { delayed: 1 },
    });
    expect(delayed.issues?.[0]).toMatchObject({
      code: 'REPORT_OVERDUE',
      severity: 'delayed',
      reporting_obligation_id: prepared.reporting_obligation_id,
    });
    expect(GetReportingStatusResponseSchema.safeParse(delayed).success).toBe(true);
  });

  it('treats a zero-row revision as a completed report, not a missing report', () => {
    const prepared = prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const beforePublication = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    const published = publishZeroRowReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const periods = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);

    expect(published.reporting_obligation_id).toBe(prepared.reporting_obligation_id);
    expect(periods).toMatchObject({ health: 'complete', obligation_counts: { complete: 1 } });
    expect(periods.ledger_snapshot_id).not.toBe(beforePublication.ledger_snapshot_id);
    expect(periods.periods?.[0]).toMatchObject({
      health: 'complete',
      production_status: 'published',
      revision_count: 1,
    });
    expect(periods.revisions?.[0]).toMatchObject({
      reporting_revision_id: published.reporting_revision_id,
      row_count: 0,
      control_totals: [],
    });
    expect(GetReportingStatusResponseSchema.safeParse(periods).success).toBe(true);

    const revision = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'revision',
      reporting_revision_id: published.reporting_revision_id,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(revision).toMatchObject({ view: 'revision', revision: { row_count: 0 } });
    expect(GetReportingStatusResponseSchema.safeParse(revision).success).toBe(true);

    advanceReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID, 'delayed');
    const reread = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'revision',
      reporting_revision_id: published.reporting_revision_id,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(reread.view === 'revision' && revision.view === 'revision' ? reread.revision : undefined)
      .toEqual(revision.view === 'revision' ? revision.revision : undefined);
  });

  it('repairs content changes from a durable checkpoint independently of health transitions', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const baseline = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(baseline.changes_checkpoint).toMatch(/^reporting_change_/);

    publishZeroRowReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const delta = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: baseline.changes_checkpoint,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(delta.periods).toHaveLength(1);
    expect(delta.revisions).toHaveLength(1);
    expect(delta.changes_checkpoint).not.toBe(baseline.changes_checkpoint);

    const unchanged = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: delta.changes_checkpoint,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(unchanged.periods).toEqual([]);
    expect(unchanged.revisions).toEqual([]);
    expect(unchanged.health).toBe(delta.health);
    expect(unchanged.obligation_counts).toEqual(delta.obligation_counts);
    expect(unchanged.coverage).toEqual(delta.coverage);

    const firstPage = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: baseline.changes_checkpoint,
      pagination: { max_results: 1 },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(firstPage.pagination?.has_more).toBe(true);
    const mismatchedCheckpoint = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: firstPage.changes_checkpoint,
      pagination: { max_results: 1, cursor: firstPage.pagination?.cursor },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(mismatchedCheckpoint).toMatchObject({ failure_kind: 'lookup_unavailable' });
  });

  it('repairs a source-timezone official close and Core adjustment through the handler runtime validator', () => {
    const prepared = prepareReliableReportingCoreIntegrityProbe('buyer:alpha', ACCOUNT_ID);
    const baseline = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(baseline).toMatchObject({
      status: 'completed',
      periods: [{
        reporting_obligation_id: prepared.reporting_obligation_id,
        period: { source_timezone: 'America/New_York' },
        schedule: { period_duration: 'P1D', alignment: 'source_timezone' },
        revision_count: 0,
        adjustment_count: 0,
      }],
      adjustments: [],
    });
    expect(Date.parse(baseline.periods?.[0]?.period.end ?? '') - Date.parse(baseline.periods?.[0]?.period.start ?? ''))
      .toBe(25 * 60 * 60 * 1000);
    expect(validateReliableReportingResponse(baseline)).toBe(baseline);

    const published = publishReliableReportingCoreIntegrityCorrection('buyer:alpha', ACCOUNT_ID);
    const repaired = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: baseline.changes_checkpoint,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(published.notification_order).toEqual(['adjustment', 'revision', 'adjustment']);
    expect(repaired).toMatchObject({
      periods: [{ revision_count: 1, adjustment_count: 1, health: 'complete' }],
      revisions: [{
        reporting_revision_id: published.reporting_revision_id,
        report_definition_id: 'training_source_calendar_billing_v1',
        report_definition_uri: 'https://test-agent.adcontextprotocol.org/reporting/definitions/source-calendar-billing-v1.json',
        finality: 'official',
        finality_policy_id: 'training_source_cutoff',
      }],
      adjustments: [{
        reporting_adjustment_id: published.reporting_adjustment_id,
        adjusts_reporting_revision_id: published.reporting_revision_id,
      }],
    });
    expect(repaired.adjustments?.[0]).not.toHaveProperty('canonical_adjustment_sha256');
    expect(validateSourceSchema('media-buy/get-reporting-status-response.json', repaired).valid).toBe(true);
    expect(validateReliableReportingResponse(repaired)).toBe(repaired);
  });

  it('executes the Managed Delivery and Reconciled Billing controller fixtures end to end', () => {
    const managed = prepareReliableReportingManagedDeliveryProbe('buyer:alpha', ACCOUNT_ID);
    expect(updateReliableReportingManagedDeliveryProbe('buyer:alpha', ACCOUNT_ID, 'suppress_readiness'))
      .toMatchObject({ readiness_notification_suppressed: true });
    const managedStatus = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'revision',
      reporting_revision_id: managed.reporting_revision_id,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(managedStatus).toMatchObject({
      materializations: [{ reporting_materialization_id: managed.reporting_materialization_id, status: 'available' }],
    });
    expect(validateReliableReportingResponse(managedStatus)).toBe(managedStatus);
    expect(updateReliableReportingManagedDeliveryProbe('buyer:alpha', ACCOUNT_ID, 'advance_within_retention'))
      .toMatchObject({ resource_readable: true, reporting_materialization_id: managed.reporting_materialization_id });
    expect(updateReliableReportingManagedDeliveryProbe('buyer:alpha', ACCOUNT_ID, 'revoke_access'))
      .toMatchObject({ access_revoked: true, historical_metadata_retained: true, revocation_elapsed_seconds: 30 });

    const billing = prepareReliableReportingReconciledBillingProbe('buyer:alpha', ACCOUNT_ID);
    const baseline = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    const revisionReceipt = syncReliableReportingReceiptsForAccount({ receipts: [{
      reporting_receipt_id: 'rr-billing-official-receipt-0001',
      reporting_obligation_id: billing.reporting_obligation_id,
      reporting_revision_id: billing.reporting_revision_id,
      reporting_materialization_id: billing.reporting_materialization_id,
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [
        { name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' },
        { name: 'spend', value: '8.00', value_type: 'decimal', unit: 'USD' },
      ],
      observed_canonical_content_digest: billing.canonical_content_digest,
      observed_at: '2026-08-27T04:01:00.000Z',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    expect(revisionReceipt).toMatchObject({ results: [{ result: 'recorded', receipt: { status: 'accepted' } }] });
    const published = publishReliableReportingReconciledAdjustments('buyer:alpha', ACCOUNT_ID);
    const adjustmentResponse = syncReliableReportingReceiptsForAccount({ adjustment_receipts: published.adjustments.map((adjustment, index) => ({
      reporting_receipt_id: `rr-adjustment-${index === 0 ? 'accepted' : 'rejected'}-receipt-01`,
      reporting_adjustment_id: adjustment.reporting_adjustment_id,
      adjusts_reporting_revision_id: billing.reporting_revision_id,
      status: index === 0 ? 'accepted' : 'rejected',
      observed_adjustment_sha256: index === 0 ? adjustment.canonical_adjustment_sha256 : published.disputed_observed_adjustment_sha256,
      ...(index === 1 && { rejection_codes: ['CANONICAL_DIGEST_MISMATCH'] }),
      observed_at: `2026-08-29T10:01:0${index}.000Z`,
    })) }, 'buyer:alpha', ACCOUNT_ID);
    expect(adjustmentResponse).toMatchObject({ results: [
      { adjustment_receipt: { status: 'accepted' } },
      { adjustment_receipt: { status: 'rejected' } },
    ] });
    const repaired = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      changes_after: baseline.changes_checkpoint,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(repaired).toMatchObject({
      periods: [{ adjustment_count: 2 }],
      adjustments: [{}, {}],
      adjustment_receipts: [{ status: 'accepted' }, { status: 'rejected' }],
    });
    expect(validateReliableReportingResponse(repaired)).toBe(repaired);
  });

  it('accepts account configurations for each advertised optional Reliable Reporting tier', () => {
    for (const [index, offering] of [
      TRAINING_REPORTING_MANAGED_OFFERING,
      TRAINING_REPORTING_RECONCILED_OFFERING,
    ].entries()) {
      expect(() => validateReportingConfigurations([{
        delivery_config_id: `optional-tier-${index}`,
        delivery_config_version: 1,
        offering_id: offering.offering_id,
        active: true,
        feed_purpose: offering.feed_purpose,
        report_definition_id: offering.report_definition_id,
        reporting_profile: offering.reporting_profile.id,
        scope: { all_media_buys: true },
        coverage_requirement: 'full',
        required_finality: 'official',
        reconciliation_mode: offering.reconciliation_mode,
        schedule: offering.schedule,
        method: {
          pattern: offering.method.pattern,
          transport: offering.method.transport,
          orchestration: offering.method.orchestration,
          destination: {
            mode: 'provision',
            provider: offering.method.provider,
            access_mode: offering.method.access_mode,
            recipient: { identity: `optional-tier-recipient-${index}` },
          },
        },
      }])).not.toThrow();
    }
  });

  it('rejects forged, mismatched, and changed-ID receipts without mutating reconciliation state', () => {
    const billing = prepareReliableReportingReconciledBillingProbe('buyer:alpha', ACCOUNT_ID);
    const validReceipt = {
      reporting_receipt_id: 'rr-billing-negative-receipt-0001',
      reporting_obligation_id: billing.reporting_obligation_id,
      reporting_revision_id: billing.reporting_revision_id,
      reporting_materialization_id: billing.reporting_materialization_id,
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [
        { name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' },
        { name: 'spend', value: '8.00', value_type: 'decimal', unit: 'USD' },
      ],
      observed_canonical_content_digest: billing.canonical_content_digest,
      observed_at: '2026-08-27T04:01:00.000Z',
    };
    const forged = syncReliableReportingReceiptsForAccount({ receipts: [{
      ...validReceipt,
      reporting_receipt_id: 'rr-billing-forged-receipt-00001',
      reporting_obligation_id: 'foreign-obligation',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    expect(forged).toMatchObject({ results: [{ result: 'failed' }] });
    expect(getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID).receipts).toEqual([]);

    expect(syncReliableReportingReceiptsForAccount({ receipts: [validReceipt] }, 'buyer:alpha', ACCOUNT_ID))
      .toMatchObject({ results: [{ result: 'recorded' }] });
    const changedRetry = syncReliableReportingReceiptsForAccount({ receipts: [{
      ...validReceipt,
      observed_at: '2026-08-27T04:02:00.000Z',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    expect(changedRetry).toMatchObject({ results: [{ result: 'failed' }] });

    const published = publishReliableReportingReconciledAdjustments('buyer:alpha', ACCOUNT_ID);
    const mismatch = syncReliableReportingReceiptsForAccount({ adjustment_receipts: [{
      reporting_receipt_id: 'rr-adjustment-mismatch-receipt-01',
      reporting_adjustment_id: published.adjustments[0]!.reporting_adjustment_id,
      adjusts_reporting_revision_id: billing.reporting_revision_id,
      status: 'accepted',
      observed_adjustment_sha256: '0'.repeat(64),
      observed_at: '2026-08-29T10:01:00.000Z',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    expect(mismatch).toMatchObject({ results: [{ result: 'failed' }] });
    const crossKindReuse = syncReliableReportingReceiptsForAccount({ adjustment_receipts: [{
      reporting_receipt_id: validReceipt.reporting_receipt_id,
      reporting_adjustment_id: published.adjustments[0]!.reporting_adjustment_id,
      adjusts_reporting_revision_id: billing.reporting_revision_id,
      status: 'accepted',
      observed_adjustment_sha256: published.adjustments[0]!.canonical_adjustment_sha256,
      observed_at: '2026-08-29T10:01:01.000Z',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    expect(crossKindReuse).toMatchObject({ results: [{ result: 'failed' }] });
    const after = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(after.receipts).toHaveLength(1);
    expect(after.adjustment_receipts).toEqual([]);
  });

  it('rejects duplicate cross-kind IDs and a combined batch above 100 before mutation', () => {
    prepareReliableReportingReconciledBillingProbe('buyer:alpha', ACCOUNT_ID);
    const duplicateId = 'rr-combined-batch-receipt-0001';
    expect(() => syncReliableReportingReceiptsForAccount({
      receipts: [{ reporting_receipt_id: duplicateId }],
      adjustment_receipts: [{ reporting_receipt_id: duplicateId }],
    }, 'buyer:alpha', ACCOUNT_ID)).toThrow(/unique across/);
    expect(() => syncReliableReportingReceiptsForAccount({
      receipts: Array.from({ length: 101 }, (_, index) => ({
        reporting_receipt_id: `rr-oversized-batch-receipt-${String(index).padStart(4, '0')}`,
      })),
    }, 'buyer:alpha', ACCOUNT_ID)).toThrow(/at most 100/);
    const after = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(after.receipts).toEqual([]);
    expect(after.adjustment_receipts).toEqual([]);
  });

  it('paginates every Reconciled Billing ledger resource exactly once in one flat union', () => {
    const billing = prepareReliableReportingReconciledBillingProbe('buyer:alpha', ACCOUNT_ID);
    syncReliableReportingReceiptsForAccount({ receipts: [{
      reporting_receipt_id: 'rr-billing-pagination-receipt-01',
      reporting_obligation_id: billing.reporting_obligation_id,
      reporting_revision_id: billing.reporting_revision_id,
      reporting_materialization_id: billing.reporting_materialization_id,
      status: 'accepted',
      verification_profile: 'canonical_digest',
      observed_row_count: 2,
      observed_control_totals: [
        { name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' },
        { name: 'spend', value: '8.00', value_type: 'decimal', unit: 'USD' },
      ],
      observed_canonical_content_digest: billing.canonical_content_digest,
      observed_at: '2026-08-27T04:01:00.000Z',
    }] }, 'buyer:alpha', ACCOUNT_ID);
    const published = publishReliableReportingReconciledAdjustments('buyer:alpha', ACCOUNT_ID);
    syncReliableReportingReceiptsForAccount({ adjustment_receipts: published.adjustments.map((adjustment, index) => ({
      reporting_receipt_id: `rr-pagination-adjustment-receipt-${index}`,
      reporting_adjustment_id: adjustment.reporting_adjustment_id,
      adjusts_reporting_revision_id: billing.reporting_revision_id,
      status: 'accepted',
      observed_adjustment_sha256: adjustment.canonical_adjustment_sha256,
      observed_at: `2026-08-29T10:01:0${index}.000Z`,
    })) }, 'buyer:alpha', ACCOUNT_ID);

    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const page = getReportingStatusForAccount({
        ...BASE_REQUEST,
        view: 'periods',
        pagination: { max_results: 1, ...(cursor && { cursor }) },
      }, 'buyer:alpha', ACCOUNT_ID);
      expect(page.pagination?.total_count).toBe(8);
      const pageResources = [
        ...(page.periods ?? []).map(value => `period:${value.reporting_obligation_id}`),
        ...(page.revisions ?? []).map(value => `revision:${value.reporting_revision_id}`),
        ...(page.adjustments ?? []).map(value => `adjustment:${(value as { reporting_adjustment_id: string }).reporting_adjustment_id}`),
        ...(page.materializations ?? []).map(value => `materialization:${(value as { reporting_materialization_id: string }).reporting_materialization_id}`),
        ...(page.receipts ?? []).map(value => `receipt:${(value as { reporting_receipt_id: string }).reporting_receipt_id}`),
        ...(page.adjustment_receipts ?? []).map(value => `adjustment_receipt:${(value as { reporting_receipt_id: string }).reporting_receipt_id}`),
      ];
      expect(pageResources).toHaveLength(1);
      seen.push(...pageResources);
      cursor = page.pagination?.has_more ? page.pagination.cursor : undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(8);
    expect(seen).toHaveLength(8);
  });

  it('excludes the exact period boundary, returns waiting for open scopes, and includes one millisecond later', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T01:00:00.000Z');
    const boundary = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(boundary).toMatchObject({ health: 'waiting', periods: [], scope: { scope_closed: false } });
    expect(validateSourceSchema('media-buy/get-reporting-status-response.json', boundary).valid).toBe(true);

    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T01:00:00.001Z');
    const after = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(after.periods).toHaveLength(1);
  });

  it('freezes eligible all_media_buys at period end and ignores buys accepted later', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, [
      { mediaBuyId: 'mb_eligible', startTime: '2026-07-31T23:00:00.000Z', endTime: '2026-08-01T02:00:00.000Z', knownAt: '2026-08-01T00:30:00.000Z' },
      { mediaBuyId: 'mb_too_late', startTime: '2026-07-31T23:00:00.000Z', endTime: '2026-08-01T02:00:00.000Z', knownAt: '2026-08-01T01:00:00.001Z' },
    ]);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, []);
    const first = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(first.periods?.[0]?.media_buy_ids).toEqual(['mb_eligible']);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, []);
    const reread = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(reread.periods?.[0]?.media_buy_ids).toEqual(['mb_eligible']);
  });

  it('versions accepted-buy applicability for future periods without rewriting frozen obligations', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, [{
      mediaBuyId: 'mb_versioned',
      startTime: '2026-07-31T23:00:00.000Z',
      endTime: '2026-08-01T03:00:00.000Z',
      knownAt: '2026-08-01T00:30:00.000Z',
      effectiveAt: '2026-08-01T00:30:00.000Z',
      packages: [{ packageId: 'pkg_versioned', supported: true }],
    }]);
    const first = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(first.periods?.[0]?.coverage.status).toBe('full');

    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, [{
      mediaBuyId: 'mb_versioned',
      startTime: '2026-07-31T23:00:00.000Z',
      endTime: '2026-08-01T03:00:00.000Z',
      knownAt: '2026-08-01T00:30:00.000Z',
      effectiveAt: '2026-08-01T01:30:00.000Z',
      packages: [{ packageId: 'pkg_versioned', supported: false }],
    }]);
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T02:00:00.001Z');
    const after = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(after.periods?.map(period => ({
      end: period.period.end,
      coverage: period.coverage.status,
      health: period.health,
    }))).toEqual([
      { end: '2026-08-01T01:00:00.000Z', coverage: 'full', health: 'delayed' },
      { end: '2026-08-01T02:00:00.000Z', coverage: 'none', health: 'action_required' },
    ]);
  });

  it('accepts lifecycle-only deactivation and reactivation while rejecting immutable changes', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const inactive = {
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      active: false,
      revocation_effective_at: '2026-08-01T02:00:00.000Z',
    };
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [inactive], '2026-08-01T01:45:00.000Z')).not.toThrow();
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [
      { ...TRAINING_REPORTING_CORE_CONFIGURATION, active: true },
    ], '2026-08-01T03:00:00.000Z')).not.toThrow();
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [
      { ...TRAINING_REPORTING_CORE_CONFIGURATION, scope: { media_buy_ids: ['mb_changed'] } },
    ], '2026-08-01T03:30:00.000Z')).toThrow(/immutable/);
  });

  it('evaluates scheduled revocation and reactivation against the ledger clock', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [{
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      active: false,
      revocation_effective_at: '2026-08-01T02:00:00.000Z',
    }], '2026-08-01T01:45:00.000Z');

    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T01:59:59.999Z');
    const before = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(before.scope?.delivery_config_generations).toHaveLength(1);

    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T02:00:00.000Z');
    const atRevocation = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(atRevocation.scope?.delivery_config_generations).toEqual([]);

    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [{
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      active: true,
    }], '2026-08-01T03:00:00.000Z');
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T04:00:00.001Z');
    const after = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(after.periods?.map(period => period.period)).toEqual([
      { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z', source_timezone: 'UTC' },
      { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T02:00:00.000Z', source_timezone: 'UTC' },
      { start: '2026-08-01T03:00:00.000Z', end: '2026-08-01T04:00:00.000Z', source_timezone: 'UTC' },
    ]);
    expect(reportingConfigurationStatesForAccount('buyer:alpha', ACCOUNT_ID)).toEqual([
      expect.objectContaining({ state: 'ready', activated_at: '2026-08-01T03:00:00.000Z' }),
    ]);
  });

  it('shortens a scheduled deactivation when replacement omits the generation', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [{
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      active: false,
      revocation_effective_at: '2026-08-01T04:00:00.000Z',
    }], '2026-08-01T01:30:00.000Z');
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T04:00:00.001Z');
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [], '2026-08-01T02:00:00.000Z');

    const periods = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      delivery_config_ids: ['training-pacing-core'],
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(periods.periods?.map(period => period.period.end)).toEqual([
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T02:00:00.000Z',
    ]);
  });

  it('rejects unknown media-buy filters and aggregates frozen denominator coverage', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, [{
      mediaBuyId: 'mb_eligible',
      startTime: '2026-07-31T23:00:00.000Z',
      endTime: '2026-08-01T02:00:00.000Z',
      knownAt: '2026-08-01T00:30:00.000Z',
      packages: [{ packageId: 'pkg_supported', supported: true }],
    }]);
    const aggregate = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'summary' }, 'buyer:alpha', ACCOUNT_ID);
    expect(aggregate.coverage).toMatchObject({
      status: 'full',
      media_buy_ids: ['mb_eligible'],
      fully_covered_media_buy_ids: ['mb_eligible'],
      covered_package_ids: ['pkg_supported'],
    });

    const unknown = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      media_buy_ids: ['mb_fabricated'],
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(unknown).toMatchObject({ status: 'failed', failure_kind: 'lookup_unavailable' });
  });

  it('fails explicit configuration scopes closed for unavailable or unsupported buys', () => {
    const scoped = {
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      scope: { media_buy_ids: ['mb_scoped'] },
    };
    expect(() => validateReportingConfigurationScopes([scoped], [])).toThrow(/unavailable/);
    expect(() => validateReportingConfigurationScopes([scoped], [{
      mediaBuyId: 'mb_scoped',
      startTime: '2026-08-01T00:00:00.000Z',
      endTime: '2026-08-01T02:00:00.000Z',
      knownAt: '2026-08-01T00:00:00.000Z',
      packages: [{ packageId: 'pkg_unsupported', supported: false }],
    }])).toThrow(/does not satisfy/);
    expect(() => validateReportingConfigurationScopes([{
      ...scoped,
      coverage_requirement: 'allow_partial',
    }], [{
      mediaBuyId: 'mb_scoped',
      startTime: '2026-08-01T00:00:00.000Z',
      endTime: '2026-08-01T02:00:00.000Z',
      knownAt: '2026-08-01T00:00:00.000Z',
      packages: [
        { packageId: 'pkg_supported', supported: true },
        { packageId: 'pkg_unsupported', supported: false },
      ],
    }])).not.toThrow();
  });

  it('makes incomplete full coverage action_required even after a revision is published', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingMediaBuyCandidates('buyer:alpha', ACCOUNT_ID, [{
      mediaBuyId: 'mb_unsupported',
      startTime: '2026-07-31T23:00:00.000Z',
      endTime: '2026-08-01T02:00:00.000Z',
      knownAt: '2026-08-01T00:30:00.000Z',
      packages: [{ packageId: 'pkg_unsupported', supported: false }],
    }]);
    publishZeroRowReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const response = getReportingStatusForAccount({ ...BASE_REQUEST, view: 'periods' }, 'buyer:alpha', ACCOUNT_ID);
    expect(response).toMatchObject({
      health: 'action_required',
      periods: [expect.objectContaining({
        health: 'action_required',
        production_status: 'published',
        issues: [expect.objectContaining({
          code: 'REPORTING_COVERAGE_INCOMPLETE',
          recommended_action: 'change_reporting_scope',
        })],
      })],
    });
    expect(GetReportingStatusResponseSchema.safeParse(response).success).toBe(true);
  });

  it('closes an empty configuration denominator even at an exact period boundary', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T01:00:00.000Z');
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [], '2026-08-01T00:30:00.000Z');
    const empty = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'summary',
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(empty).toMatchObject({ health: 'complete', scope: { scope_closed: true } });
    expect(empty).not.toHaveProperty('next_expected_at');
  });

  it('accepts distinct versions sharing one delivery_config_id and rejects only duplicate tuples', () => {
    const appliedAt = '2026-08-01T00:00:00.000Z';
    const versionOneInactive = { ...TRAINING_REPORTING_CORE_CONFIGURATION, active: false };
    const versionTwo = { ...TRAINING_REPORTING_CORE_CONFIGURATION, delivery_config_version: 2 };
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [
      versionOneInactive,
      versionTwo,
    ], appliedAt)).not.toThrow();
    const liveStates = reportingConfigurationStatesForAccount('buyer:alpha', ACCOUNT_ID);
    const previewStates = projectedReportingConfigurationStates([versionOneInactive, versionTwo], appliedAt);
    expect(liveStates.map(state => state.state)).toEqual(previewStates.map(state => state.state));
    expect(liveStates).toHaveLength(2);
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [
      TRAINING_REPORTING_CORE_CONFIGURATION,
      TRAINING_REPORTING_CORE_CONFIGURATION,
    ], '2026-08-01T00:00:00.000Z')).toThrow(/version 1 must be unique/);
    expect(() => replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [
      TRAINING_REPORTING_CORE_CONFIGURATION,
      versionTwo,
    ], '2026-08-01T00:00:00.000Z')).toThrow(/only one active generation/);
  });

  it('prevents superseded-generation overlap and scopes generation metadata to the query horizon', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [{
      ...TRAINING_REPORTING_CORE_CONFIGURATION,
      active: false,
      revocation_effective_at: '2026-08-01T04:00:00.000Z',
    }], '2026-08-01T01:00:00.000Z');
    const versionTwo = { ...TRAINING_REPORTING_CORE_CONFIGURATION, delivery_config_version: 2 };
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [versionTwo], '2026-08-01T03:00:00.000Z');
    setReportingCoreLifecycleProbeClock('buyer:alpha', ACCOUNT_ID, '2026-08-01T04:00:00.001Z');

    const beforeReplacement = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      delivery_config_ids: ['training-pacing-core'],
      period: { start: '2026-08-01T01:00:00.000Z', end: '2026-08-01T02:00:00.000Z' },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(beforeReplacement.scope?.delivery_config_generations).toEqual([
      expect.objectContaining({ delivery_config_version: 1 }),
    ]);

    const afterReplacement = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      delivery_config_ids: ['training-pacing-core'],
      period: { start: '2026-08-01T03:00:00.000Z', end: '2026-08-01T04:00:00.000Z' },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(afterReplacement.scope?.delivery_config_generations).toEqual([
      expect.objectContaining({ delivery_config_version: 2 }),
    ]);
    expect(afterReplacement.periods).toEqual([
      expect.objectContaining({ delivery_config_version: 2 }),
    ]);
  });

  it('does not disclose another caller configuration, obligation, or revision', () => {
    const prepared = prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    publishZeroRowReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);

    const otherCaller = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      delivery_config_ids: ['training-pacing-core'],
    }, 'buyer:bravo', ACCOUNT_ID);
    expect(otherCaller).toMatchObject({
      status: 'failed',
      failure_kind: 'lookup_unavailable',
      errors: [{ code: 'NOT_FOUND' }],
    });
    expect(JSON.stringify(otherCaller)).not.toContain(prepared.reporting_obligation_id);
    expect(GetReportingStatusResponseSchema.safeParse(otherCaller).success).toBe(true);
  });

  it('retains a superseded/deactivated generation and walks a stable resource cursor', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const published = publishZeroRowReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const first = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      pagination: { max_results: 1 },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(first.pagination).toMatchObject({ has_more: true, total_count: 2 });
    expect(first.pagination?.cursor).not.toContain('offset');
    expect(first.periods).toHaveLength(1);
    const second = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      pagination: { max_results: 1, cursor: first.pagination?.cursor },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(second.ledger_snapshot_id).toBe(first.ledger_snapshot_id);
    expect(second.periods).toEqual([]);
    expect(second.revisions).toHaveLength(1);
    expect(GetReportingStatusResponseSchema.safeParse(second).success).toBe(true);
    const forged = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      pagination: { max_results: 1, cursor: Buffer.from(JSON.stringify({ offset: 1, as_of: '2099-01-01T00:00:00Z' })).toString('base64url') },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(forged.status).toBe('failed');

    const versionTwo = { ...TRAINING_REPORTING_CORE_CONFIGURATION, delivery_config_version: 2 };
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [versionTwo], '2026-08-01T01:30:00.000Z');
    replaceReportingConfigurations('buyer:alpha', ACCOUNT_ID, [], '2026-08-01T01:30:00.000Z');
    const historic = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'periods',
      delivery_config_ids: ['training-pacing-core'],
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(historic.periods?.some(period => period.delivery_config_version === 1)).toBe(true);
    const retainedRevision = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'revision',
      reporting_revision_id: published.reporting_revision_id,
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(retainedRevision.status).toBe('completed');
  });

  it('rejects a horizon outside the retained ledger rather than claiming completion', () => {
    prepareReportingCoreLifecycleProbe('buyer:alpha', ACCOUNT_ID);
    const old = getReportingStatusForAccount({
      ...BASE_REQUEST,
      view: 'summary',
      period: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T01:00:00.000Z' },
    }, 'buyer:alpha', ACCOUNT_ID);
    expect(old).toMatchObject({ status: 'failed', failure_kind: 'lookup_unavailable' });
    expect(GetReportingStatusResponseSchema.safeParse(old).success).toBe(true);
  });
});

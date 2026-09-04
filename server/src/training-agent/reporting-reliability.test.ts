/**
 * Regression tests for the four sub-bugs fixed in PR #7228 (branch mumbai-v6):
 *
 *   1A  recordsFor uses hardcoded HOUR_MS step regardless of period_duration;
 *       expected_at also hardcoded to +HOUR_MS instead of +delivery_sla.
 *   1B  reconciled health treated adjustment receipts as an unconditional
 *       precondition, or failed to account for their receipt totals.
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
  setReportingCoreLifecycleProbeClock,
  prepareReliableReportingReconciledBillingProbe,
  publishReliableReportingReconciledAdjustments,
  TRAINING_REPORTING_MANAGED_OFFERING,
  type TrainingGetReportingStatusRequest,
  type TrainingGetReportingStatusResponse,
} from './reporting-reliability.js';

describe('Reliable Reporting pipeline – PR #7228 regression suite', () => {
  beforeEach(() => {
    clearReportingReliabilityStore();
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
  });

  // ---------------------------------------------------------------------------
  // Bug 1B: a clean official close needs no adjustment receipt; after an
  // adjustment is published, its accepted receipt is required and counted.
  // ---------------------------------------------------------------------------
  it('reconciles a clean official close, then waits for and counts adjustment receipts', () => {
    const principal = 'test-pr7228-1b';
    const accountId = 'acct-1b';

    const probe = prepareReliableReportingReconciledBillingProbe(principal, accountId);

    // Submit an accepted revision receipt. The canonical_digest verification data
    // is taken directly from the probe fixture (row_count=2, canonical SHA present).
    syncReliableReportingReceiptsForAccount(
      {
        receipts: [{
          reporting_receipt_id: 'rcpt-1b-rev-0001',
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
          observed_at: '2026-08-29T10:00:00.000Z',
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

    // A clean official close has no adjustment precondition.
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
    const afterPublication = getReportingStatusForAccount(
      { view: 'periods' } as TrainingGetReportingStatusRequest,
      principal,
      accountId,
    ) as TrainingGetReportingStatusResponse;
    expect(afterPublication.periods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        health: 'waiting',
        adjustment_count: 2,
        adjustment_receipt_count: 0,
        accepted_adjustment_receipt_count: 0,
      }),
    ]));

    // Now submit the accepted adjustment receipt.
    const acceptedAdj = adjustments.find(a => a.reason_code === 'invalid_traffic')!;
    syncReliableReportingReceiptsForAccount(
      {
        adjustment_receipts: [{
          reporting_receipt_id: 'rcpt-1b-adj-0001',
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

    expect(afterAdjustment.periods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        health: 'complete',
        adjustment_count: 2,
        adjustment_receipt_count: 1,
        accepted_adjustment_receipt_count: 1,
      }),
    ]));
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
  });
});

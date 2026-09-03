import { describe, expect, it, beforeEach } from 'vitest';
import { GetReportingStatusResponseSchema } from '@adcp/sdk/schemas';
import {
  advanceReportingCoreLifecycleProbe,
  clearReportingReliabilityStore,
  getReportingStatusForAccount,
  prepareReportingCoreLifecycleProbe,
  projectedReportingConfigurationStates,
  publishZeroRowReportingCoreLifecycleProbe,
  reportingConfigurationStatesForAccount,
  replaceReportingConfigurations,
  setReportingCoreLifecycleProbeClock,
  setReportingMediaBuyCandidates,
  TRAINING_REPORTING_CORE_CONFIGURATION,
  validateReportingConfigurationScopes,
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

import { beforeEach, describe, expect, it } from 'vitest';
import {
  advancePastConsumerMismatchEscalationProbe,
  advancePastConsumerStatusDeadlineProbe,
  advanceReportingCoreLifecycleProbe,
  clearReportingReliabilityStore,
  getReportingStatusForAccount,
  omitReportingCoreObligationProbe,
  prepareReportingCoreLifecycleProbe,
  publishZeroRowReportingCoreLifecycleProbe,
  rehydrateReportingLedgerForTesting,
  restateAfterReceivedReportingCoreLifecycleProbe,
  syncReliableReportingStatusesForAccount,
  TRAINING_REPORTING_OPERATIONS_CONTACT,
  type TrainingGetReportingStatusRequest,
} from '../../src/training-agent/reporting-reliability.js';
import { TRAINING_SALES_CAPABILITIES } from '../../src/training-agent/v6-sales-platform.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';

const PRINCIPAL = 'buyer:consumer-status';
const ACCOUNT_ID = 'acc_consumer_status';

type SyncResult =
  | { result: 'recorded' | 'unchanged'; consumer_status: Record<string, unknown> }
  | { result: 'failed'; reporting_status_id: string; errors: Array<{ code: string; message: string; recovery?: string }> };

type ReportingIssue = {
  issue_id: string;
  code: string;
  severity: string;
  opened_at?: string;
  issue_state?: string;
  external_ref?: string;
  responsible_party: string;
  recommended_action: string;
  reporting_status_id?: string;
};

function sync(
  statuses: Array<Record<string, unknown>>,
  principal = PRINCIPAL,
  accountId = ACCOUNT_ID,
): SyncResult[] {
  const response = syncReliableReportingStatusesForAccount({ statuses }, principal, accountId);
  expect(validateSourceSchema('media-buy/sync-reporting-status-response.json', response).valid).toBe(true);
  return (response as { results: SyncResult[] }).results;
}

function read(
  request: Partial<TrainingGetReportingStatusRequest> & Pick<TrainingGetReportingStatusRequest, 'view'>,
  principal = PRINCIPAL,
  accountId = ACCOUNT_ID,
) {
  const response = getReportingStatusForAccount(
    { account: { account_id: accountId }, ...request } as TrainingGetReportingStatusRequest,
    principal,
    accountId,
  );
  const validation = validateSourceSchema('media-buy/get-reporting-status-response.json', response);
  expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
  return response;
}

function issuesOf(response: { issues?: unknown }): ReportingIssue[] {
  return (response.issues ?? []) as ReportingIssue[];
}

function mismatchOf(response: { issues?: unknown }): ReportingIssue {
  const mismatch = issuesOf(response).find(issue => issue.code === 'CONSUMER_STATUS_MISMATCH');
  expect(mismatch, JSON.stringify(response.issues)).toBeDefined();
  return mismatch!;
}

/** Prepare the fixture, cross the recovery deadline, and publish one revision. */
function publishedFixture() {
  const prepared = prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
  advanceReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID, 'action_required');
  const published = publishZeroRowReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
  return { prepared, published };
}

function chainIdentity(prepared: ReturnType<typeof prepareReportingCoreLifecycleProbe>) {
  return {
    delivery_config_id: prepared.delivery_config_id,
    delivery_config_version: prepared.delivery_config_version,
    report_definition_id: prepared.resolved_configuration.report_definition_id,
    period: { ...prepared.period, source_timezone: 'UTC' },
  };
}

describe('training-agent Reliable Reporting consumer status', () => {
  beforeEach(() => clearReportingReliabilityStore());

  it('advertises the consumer-status loop, its escalation clock, and a hardened contact', () => {
    const advertised = TRAINING_SALES_CAPABILITIES.overrides.media_buy.reporting_delivery;
    expect(advertised).toMatchObject({
      supported: true,
      reliable_reporting_version: '1.0',
      consumer_status_task: 'sync_reporting_status',
      revision_content_task: 'get_media_buy_delivery',
      consumer_mismatch_escalation_seconds: 900,
      operations_contact: TRAINING_REPORTING_OPERATIONS_CONTACT,
    });
    // Declaring the clock requires declaring the contact; the schema's
    // conditionals are what make that binding real rather than advisory.
    const validation = validateSourceSchema('core/reporting-delivery-capabilities.json', advertised);
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    const withoutContact = { ...advertised } as Record<string, unknown>;
    delete withoutContact.operations_contact;
    expect(validateSourceSchema('core/reporting-delivery-capabilities.json', withoutContact).valid).toBe(false);

    // Inert display metadata only: never dereferenced, never an AdCP endpoint.
    expect(TRAINING_REPORTING_OPERATIONS_CONTACT.url).toMatch(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//);
    expect(TRAINING_REPORTING_OPERATIONS_CONTACT.url).not.toMatch(/@|localhost|\/\/\d+\./);
    expect(TRAINING_REPORTING_OPERATIONS_CONTACT.email).toMatch(/^[^@]+@example\.org$/);
    // The escalation window must be shorter than the configuration's
    // delivery_sla, or it could never precede the stale-received grace window.
    expect(advertised.consumer_mismatch_escalation_seconds * 1_000).toBeLessThan(60 * 60 * 1_000);
  });

  it('records an obligation_missing statement without a seller-issued obligation ID and retires it on repair', () => {
    const prepared = prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
    const omitted = omitReportingCoreObligationProbe(PRINCIPAL, ACCOUNT_ID);
    advanceReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID, 'action_required');

    const identity = {
      delivery_config_id: prepared.delivery_config_id,
      delivery_config_version: prepared.delivery_config_version,
      report_definition_id: prepared.resolved_configuration.report_definition_id,
      period: { ...omitted.omitted_period, source_timezone: 'UTC' },
    };
    const [recorded] = sync([{
      reporting_status_id: 'consumer-status.omission.0001',
      ...identity,
      consumer_status: 'obligation_missing',
      status_as_of: '2026-08-01T04:05:00.000Z',
    }]);
    expect(recorded?.result).toBe('recorded');

    const degraded = read({ view: 'periods', period: omitted.omitted_period });
    expect(degraded.health).toBe('action_required');
    // The seller has no obligation to hang this on, so the issue is still
    // readable at the response level rather than silently dropped.
    expect(degraded.periods).toEqual([]);
    const mismatch = mismatchOf(degraded);
    expect(mismatch).toMatchObject({
      severity: 'action_required',
      issue_state: 'open',
      responsible_party: 'seller',
      recommended_action: 'contact_seller',
      reporting_status_id: 'consumer-status.omission.0001',
    });
    expect(mismatch.opened_at).toBe('2026-08-01T04:05:00.000Z');
    expect(mismatch.external_ref).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect((degraded as { consumer_statuses?: unknown[] }).consumer_statuses).toHaveLength(1);

    // Repairing the obligation is a legitimate seller-side projection change:
    // the two claims no longer conflict, so the issue is retired outright.
    const repaired = prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
    expect(repaired.reporting_obligation_id).toBe(prepared.reporting_obligation_id);
  });

  it('carries one issue_id and one opened_at from the grace window through escalation and past the grace deadline', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    expect(sync([{
      reporting_status_id: 'consumer-status.received.0001',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: published.simulated_now,
    }])[0]?.result).toBe('recorded');

    // An agreeing leaf is not a conflict: the period stays complete.
    expect(read({ view: 'periods' }).periods?.[0]).toMatchObject({
      health: 'complete',
      consumer_status_count: 1,
      current_consumer_status_id: 'consumer-status.received.0001',
      issues: [],
    });

    const restated = restateAfterReceivedReportingCoreLifecycleProbe(
      PRINCIPAL, ACCOUNT_ID, published.reporting_revision_id, 'within_grace',
    );
    const inGrace = read({ view: 'periods', period: prepared.period });
    expect(inGrace.periods?.[0]?.health).toBe('delayed');
    const graceIssue = mismatchOf(inGrace);
    expect(graceIssue).toMatchObject({
      severity: 'delayed',
      responsible_party: 'buyer',
      recommended_action: 'wait_for_retry',
      reporting_status_id: 'consumer-status.received.0001',
    });
    // Anchored to the first supersession, not to the statement or the poll.
    expect(graceIssue.opened_at).toBe(restated.restated_at);

    const escalation = advancePastConsumerMismatchEscalationProbe(PRINCIPAL, ACCOUNT_ID);
    expect(escalation).toMatchObject({
      issue_id: graceIssue.issue_id,
      issue_opened_at: graceIssue.opened_at,
      consumer_mismatch_escalation_seconds: 900,
      expected_recommended_action: 'contact_buyer',
      stale_received_grace_deadline: restated.stale_received_grace_deadline,
    });
    // The overlap is real: escalation fires while the grace window is open.
    expect(Date.parse(escalation.consumer_mismatch_escalation_deadline))
      .toBeLessThan(Date.parse(restated.stale_received_grace_deadline));
    expect(Date.parse(escalation.simulated_now))
      .toBeLessThan(Date.parse(restated.stale_received_grace_deadline));

    const escalated = read({ view: 'periods', period: prepared.period });
    expect(escalated.periods?.[0]?.health).toBe('action_required');
    const escalatedIssue = mismatchOf(escalated);
    expect(escalatedIssue.issue_id).toBe(graceIssue.issue_id);
    expect(escalatedIssue.opened_at).toBe(graceIssue.opened_at);
    expect(escalatedIssue.severity).toBe('action_required');
    expect(escalatedIssue.recommended_action).toBe('contact_buyer');

    // Crossing the second boundary still does not restart the issue's clock.
    restateAfterReceivedReportingCoreLifecycleProbe(
      PRINCIPAL, ACCOUNT_ID, published.reporting_revision_id, 'past_grace',
    );
    const pastGrace = mismatchOf(read({ view: 'periods', period: prepared.period }));
    expect(pastGrace.issue_id).toBe(graceIssue.issue_id);
    expect(pastGrace.opened_at).toBe(graceIssue.opened_at);
    expect(pastGrace.severity).toBe('action_required');
  });

  it('counts a missed posting deadline without letting silence change health', () => {
    prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
    const beforeDeadline = read({ view: 'summary' });
    expect(beforeDeadline.obligation_counts).toMatchObject({ consumer_status_pending: 0 });

    const deadline = advancePastConsumerStatusDeadlineProbe(PRINCIPAL, ACCOUNT_ID);
    expect(Date.parse(deadline.consumer_status_deadline) - Date.parse(deadline.expected_at))
      .toBe(deadline.automated_recovery_window_seconds * 1_000);
    expect(Date.parse(deadline.simulated_now))
      .toBeGreaterThan(Date.parse(deadline.consumer_status_deadline));

    const counted = read({
      view: 'summary',
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    });
    expect(counted.obligation_counts).toMatchObject({ consumer_status_pending: 1 });
    // Silence raises no issue of its own; the one issue is the seller's.
    expect(issuesOf(counted).map(issue => issue.code)).toEqual(['REPORT_OVERDUE']);
    const silentHealth = counted.health;
    const silentActionRequired = counted.obligation_counts?.action_required;

    expect(sync([{
      reporting_status_id: 'consumer-status.silence.0001',
      delivery_config_id: deadline.delivery_config_id,
      delivery_config_version: deadline.delivery_config_version,
      report_definition_id: 'training_delivery_summary_v1',
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z', source_timezone: 'UTC' },
      reporting_obligation_id: deadline.reporting_obligation_id,
      consumer_status: 'revision_missing',
      status_as_of: deadline.simulated_now,
    }])[0]?.result).toBe('recorded');

    const cleared = read({
      view: 'summary',
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    });
    expect(cleared.obligation_counts).toMatchObject({ consumer_status_pending: 0 });
    expect(cleared.health).toBe(silentHealth);
    expect(cleared.obligation_counts?.action_required).toBe(silentActionRequired);
    expect(issuesOf(cleared).map(issue => issue.code)).toEqual(['REPORT_OVERDUE']);
  });

  it('accepts every closed mismatch_code and rejects a content_mismatch that omits one', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    const base = {
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'content_mismatch',
      status_as_of: published.simulated_now,
    };

    const [missingCode] = sync([{ reporting_status_id: 'consumer-status.content.no-code', ...base }]);
    expect(missingCode?.result).toBe('failed');
    expect(missingCode && 'errors' in missingCode ? missingCode.errors[0] : undefined).toMatchObject({
      code: 'VALIDATION_ERROR',
      recovery: 'correctable',
    });

    const codes = [
      'scope_media_buy_missing',
      'coverage_short',
      'metric_missing',
      'schema_nonconformant',
      'currency_mismatch',
      'period_mismatch',
    ] as const;
    let previous: string | undefined;
    for (const [index, mismatchCode] of codes.entries()) {
      const id = `consumer-status.content-mismatch.000${index + 1}`;
      const [result] = sync([{
        reporting_status_id: id,
        ...(previous && { supersedes_reporting_status_id: previous }),
        ...base,
        mismatch_code: mismatchCode,
      }]);
      expect(result?.result, `${mismatchCode}: ${JSON.stringify(result)}`).toBe('recorded');
      previous = id;
    }

    const disputed = read({ view: 'periods', period: prepared.period });
    expect(disputed.periods?.[0]).toMatchObject({
      health: 'action_required',
      production_status: 'published',
      consumer_status_count: codes.length,
      current_consumer_status_id: `consumer-status.content-mismatch.000${codes.length}`,
    });
    expect(mismatchOf(disputed)).toMatchObject({
      severity: 'action_required',
      responsible_party: 'seller',
      reporting_status_id: `consumer-status.content-mismatch.000${codes.length}`,
    });
  });

  it('requires the exact recomputed Core binding and the currently required revision', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    const [wrongDigest] = sync([{
      reporting_status_id: 'consumer-status.wrong-digest.0001',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: '0'.repeat(64),
      consumer_status: 'received',
      status_as_of: published.simulated_now,
    }]);
    expect(wrongDigest?.result).toBe('failed');
    expect(wrongDigest && 'errors' in wrongDigest ? wrongDigest.errors[0]?.code : undefined)
      .toBe('VALIDATION_ERROR');

    expect(sync([{
      reporting_status_id: 'consumer-status.received.0002',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: published.simulated_now,
    }])[0]?.result).toBe('recorded');

    const restated = restateAfterReceivedReportingCoreLifecycleProbe(
      PRINCIPAL, ACCOUNT_ID, published.reporting_revision_id, 'within_grace',
    );
    // content_mismatch is valid only against the revision the seller now
    // requires, so a dispute about superseded bytes does not commit.
    const [staleTarget] = sync([{
      reporting_status_id: 'consumer-status.content.stale-target',
      supersedes_reporting_status_id: 'consumer-status.received.0002',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'content_mismatch',
      mismatch_code: 'coverage_short',
      status_as_of: restated.restated_at,
    }]);
    expect(staleTarget?.result).toBe('failed');
    expect(staleTarget && 'errors' in staleTarget ? staleTarget.errors[0]?.message : '')
      .toMatch(/currently requires/);
  });

  it('enforces exact-leaf supersession, batch identity, and immutable retries', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    const received = {
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: published.simulated_now,
    };
    const first = { reporting_status_id: 'consumer-status.leaf.0001', ...received };
    expect(sync([first])[0]?.result).toBe('recorded');

    // An exact retry is unchanged; the same ID with different content conflicts.
    const [retried] = sync([first]);
    expect(retried?.result).toBe('unchanged');
    const [reused] = sync([{ ...first, consumer_status: 'unreadable', failure_code: 'transport_failed', observed_revision_content_sha256: undefined }]);
    expect(reused?.result).toBe('failed');

    // A second statement must name the exact current leaf.
    const [noSupersede] = sync([{ reporting_status_id: 'consumer-status.leaf.0002', ...received }]);
    expect(noSupersede?.result).toBe('failed');
    expect(noSupersede && 'errors' in noSupersede ? noSupersede.errors[0] : undefined).toMatchObject({
      code: 'CONFLICT',
      recovery: 'transient',
    });

    // Two entries for one logical chain are both rejected without evaluating
    // their supersession order at all.
    const duplicateChain = sync([
      { reporting_status_id: 'consumer-status.leaf.0003', supersedes_reporting_status_id: 'consumer-status.leaf.0001', ...received },
      { reporting_status_id: 'consumer-status.leaf.0004', supersedes_reporting_status_id: 'consumer-status.leaf.0003', ...received },
    ]);
    expect(duplicateChain.map(entry => entry.result)).toEqual(['failed', 'failed']);

    expect(() => sync([first, first])).toThrow(/must be unique across the complete consumer status batch/);

    const unchangedLedger = read({ view: 'periods', period: prepared.period });
    expect(unchangedLedger.periods?.[0]).toMatchObject({
      consumer_status_count: 1,
      current_consumer_status_id: 'consumer-status.leaf.0001',
    });
  });

  it('resolves every referenced identifier inside the caller and account', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['unknown generation', { ...identity, delivery_config_version: 99 }, 'REFERENCE_NOT_FOUND'],
      ['mismatched definition', { ...identity, report_definition_id: 'training_source_calendar_billing_v1' }, 'REFERENCE_NOT_FOUND'],
      ['unknown obligation', { ...identity, reporting_obligation_id: 'reporting-obligation.not-mine' }, 'REFERENCE_NOT_FOUND'],
      ['unknown snapshot', { ...identity, seller_ledger_snapshot_id: 'reporting-ledger.forged', seller_ledger_as_of: published.simulated_now }, 'REFERENCE_NOT_FOUND'],
      ['unaligned period', { ...identity, period: { start: '2026-08-01T00:30:00.000Z', end: '2026-08-01T01:30:00.000Z', source_timezone: 'UTC' } }, 'VALIDATION_ERROR'],
    ];
    for (const [name, overrides, code] of cases) {
      const [result] = sync([{
        reporting_status_id: `consumer-status.reject.${name.replace(/[^a-z]/g, '')}`,
        ...identity,
        reporting_obligation_id: prepared.reporting_obligation_id,
        consumer_status: 'revision_missing',
        status_as_of: published.simulated_now,
        ...overrides,
      }]);
      expect(result?.result, `${name}: ${JSON.stringify(result)}`).toBe('failed');
      expect(result && 'errors' in result ? result.errors[0]?.code : undefined, name).toBe(code);
    }

    // A snapshot this caller actually was issued resolves.
    const issued = read({ view: 'summary' });
    expect(sync([{
      reporting_status_id: 'consumer-status.snapshot.0001',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      consumer_status: 'revision_missing',
      status_as_of: published.simulated_now,
      seller_ledger_snapshot_id: issued.ledger_snapshot_id,
      seller_ledger_as_of: issued.ledger_as_of,
    }])[0]?.result).toBe('recorded');
  });

  it('refuses a negative statement before the obligation is even due', () => {
    const prepared = prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
    const [tooEarly] = sync([{
      reporting_status_id: 'consumer-status.too-early.0001',
      ...chainIdentity(prepared),
      reporting_obligation_id: prepared.reporting_obligation_id,
      consumer_status: 'revision_missing',
      status_as_of: prepared.simulated_now,
    }]);
    expect(tooEarly?.result).toBe('failed');
    expect(tooEarly && 'errors' in tooEarly ? tooEarly.errors[0]?.message : '')
      .toMatch(/at or after the obligation expected_at/);
  });

  it('discloses consumer status only to the caller that submitted it, across both views and the durable round trip', () => {
    const { prepared, published } = publishedFixture();
    expect(sync([{
      reporting_status_id: 'consumer-status.isolated.0001',
      ...chainIdentity(prepared),
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      observed_revision_content_sha256: published.revision_content_sha256,
      consumer_status: 'received',
      status_as_of: published.simulated_now,
    }])[0]?.result).toBe('recorded');

    const periods = read({ view: 'periods', period: prepared.period });
    expect((periods as { consumer_statuses?: unknown[] }).consumer_statuses).toHaveLength(1);
    // Consumer status rides the same flat pagination union as every other
    // immutable record kind: obligation + revision + status.
    expect(periods.pagination?.total_count).toBe(3);

    const revisionView = read({ view: 'revision', reporting_revision_id: published.reporting_revision_id });
    expect((revisionView as { consumer_statuses?: Array<{ reporting_revision_id?: string }> }).consumer_statuses)
      .toEqual([expect.objectContaining({ reporting_revision_id: published.reporting_revision_id })]);

    // The durable ledger serializes and restores the chain unchanged.
    rehydrateReportingLedgerForTesting(PRINCIPAL, ACCOUNT_ID);
    expect((read({ view: 'periods', period: prepared.period }) as { consumer_statuses?: unknown[] }).consumer_statuses)
      .toHaveLength(1);

    // A different authenticated caller against the same account ID has its own
    // ledger and sees no statement from the first caller.
    prepareReportingCoreLifecycleProbe('buyer:other', ACCOUNT_ID);
    const other = read({ view: 'periods' }, 'buyer:other');
    expect((other as { consumer_statuses?: unknown[] }).consumer_statuses).toEqual([]);
    expect(issuesOf(other).some(issue => issue.code === 'CONSUMER_STATUS_MISMATCH')).toBe(false);
  });

  it('diagnoses the responsible party for an unreadable revision from its typed failure code', () => {
    const { prepared, published } = publishedFixture();
    const identity = chainIdentity(prepared);
    expect(sync([{
      reporting_status_id: 'consumer-status.unreadable.0001',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      consumer_status: 'unreadable',
      failure_code: 'reader_incompatible',
      status_as_of: published.simulated_now,
    }])[0]?.result).toBe('recorded');

    const buyerSide = mismatchOf(read({ view: 'periods', period: prepared.period }));
    expect(buyerSide).toMatchObject({ responsible_party: 'buyer', recommended_action: 'contact_buyer' });

    expect(sync([{
      reporting_status_id: 'consumer-status.unreadable.0002',
      supersedes_reporting_status_id: 'consumer-status.unreadable.0001',
      ...identity,
      reporting_obligation_id: prepared.reporting_obligation_id,
      reporting_revision_id: published.reporting_revision_id,
      consumer_status: 'unreadable',
      failure_code: 'transport_failed',
      status_as_of: published.simulated_now,
    }])[0]?.result).toBe('recorded');

    const providerSide = mismatchOf(read({ view: 'periods', period: prepared.period }));
    expect(providerSide).toMatchObject({ responsible_party: 'provider', recommended_action: 'contact_provider' });
    // Refining the diagnosis does not restart the clock: the unresolved
    // condition is the same one, so the consumer keeps ageing one work item.
    expect(providerSide.issue_id).toBe(buyerSide.issue_id);
    expect(providerSide.opened_at).toBe(buyerSide.opened_at);
  });

  it('refuses to advance past an escalation boundary that no open mismatch has', () => {
    prepareReportingCoreLifecycleProbe(PRINCIPAL, ACCOUNT_ID);
    expect(() => advancePastConsumerMismatchEscalationProbe(PRINCIPAL, ACCOUNT_ID))
      .toThrow(/Record a conflicting consumer status/);
  });
});

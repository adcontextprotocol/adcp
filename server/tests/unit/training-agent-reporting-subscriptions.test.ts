import { beforeEach, describe, expect, it } from 'vitest';

const { clearSessions, flushDirtySessions, getSession, runWithSessionContext, sessionKeyFromArgs } = await import('../../src/training-agent/state.js');
const { callerAccountRef, clearAccountStore, findCallerAccount } = await import('../../src/training-agent/account-handlers.js');
const { handleRequestAccount } = await import('../../src/training-agent/account-requests.js');
const { handleReportingSubscriptionProbe } = await import('../../src/training-agent/subscription-probe.js');
const { getPrincipalLegacy, syncPrincipalLegacy } = await import('../../src/training-agent/principal.js');
const { subscriptionReportingView } = await import('../../src/training-agent/subscription-coverage-service.js');
const { getReportingStatusForAccount, validateReliableReportingResponse } = await import('../../src/training-agent/reporting-reliability.js');
const { buildCatalog } = await import('../../src/training-agent/product-factory.js');
const { expectedSubscriptionPeriods } = await import('../../src/training-agent/reporting-coverage-model.js');

type Json = Record<string, any>;
type Ctx = Parameters<typeof handleRequestAccount>[1];

const ctx = (principal = 'static:buyer-a'): Ctx => ({ mode: 'open', principal, servedAdcpVersion: '3.3-beta.3' });

let keyCounter = 0;
const key = () => `subscription-key-${String(++keyCounter).padStart(6, '0')}`;

const inSession = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithSessionContext(async () => {
    const result = await fn();
    await flushDirtySessions();
    return result;
  });

const probe = (params: Json, context: Ctx = ctx()) =>
  inSession(() => handleReportingSubscriptionProbe(params, context)) as Promise<Json>;
const advance = (target: string) => probe({ operation: 'advance_time', target_time: target });
const sync = (subscriptions: Json[], context: Ctx = ctx(), extra: Json = {}) =>
  inSession(() => syncPrincipalLegacy({ idempotency_key: key(), configuration: { reporting_subscriptions: subscriptions }, ...extra } as never, context)) as Promise<Json>;
const readPrincipal = (args: Json = {}, context: Ctx = ctx()) =>
  inSession(() => getPrincipalLegacy(args as never, context)) as Promise<Json>;
const view = (accountId: string, context: Ctx = ctx()) =>
  inSession(() => subscriptionReportingView(context, accountId)) as Promise<Json>;

const PRODUCT_ID = buildCatalog()[0]!.product.product_id;

async function openAccount(overrides: Json = {}): Promise<string> {
  const result = await inSession(() => handleRequestAccount({
    idempotency_key: key(),
    brand: { domain: 'nova-athletics.example' },
    operator: 'pinnacle-media.example',
    operator_unit: { id: `unit-${++keyCounter}` },
    timezone: 'America/New_York',
    sandbox: true,
    billing: 'operator',
    ...overrides,
  } as never, ctx())) as Json;
  expect(result.request.state).toBe('resolved');
  return result.request.account_id;
}

async function seedBuy(accountId: string, buy: Json): Promise<void> {
  await inSession(async () => {
    const state = (await findCallerAccount(ctx(), accountId))!;
    const session = await getSession(sessionKeyFromArgs({ account: callerAccountRef(state) }, 'open', undefined, undefined, 'static:buyer-a'));
    session.mediaBuys.set(buy.media_buy_id, {
      mediaBuyId: buy.media_buy_id,
      accountRef: { account_id: accountId },
      status: 'active',
      currency: 'USD',
      packages: [{ packageId: 'pkg_1', productId: PRODUCT_ID, budget: 1000, pricingOptionId: 'po', paused: false, startTime: buy.start_time, endTime: buy.end_time, creativeAssignments: [] }],
      startTime: buy.start_time,
      endTime: buy.end_time,
      revision: 1,
      confirmedAt: buy.confirmed_at,
      ...(buy.canceled_at && { canceledAt: buy.canceled_at }),
      createdAt: buy.confirmed_at,
      updatedAt: buy.confirmed_at,
      history: [],
    } as never);
  });
}

const daily = (overrides: Json = {}): Json => ({
  subscription_id: 'analytics-daily',
  subscription_version: 1,
  active: true,
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official', alignment: 'account_timezone' },
  reconciliation_mode: 'delivery_only',
  ...overrides,
});

const starts = (records: Json[]) => records.map(record => record.period.start);

beforeEach(async () => {
  await clearSessions();
  clearAccountStore();
});

describe('reporting subscriptions: registration and readback', () => {
  it('versions, deactivates, and reactivates with the readback a buyer recomputes from', async () => {
    await advance('2030-06-01T00:00:00Z');
    const applied = await sync([daily()]);
    expect(applied.result.kind).toBe('applied');
    expect(applied.result.configuration.reporting_subscriptions[0]).toMatchObject({
      subscription_id: 'analytics-daily', subscription_version: 1, state: 'active', accepted_at: '2030-06-01T00:00:00.000Z',
    });

    await advance('2030-06-03T12:00:00Z');
    await sync([daily({ subscription_version: 2, selector: { feed_purpose: 'pacing', period_duration: 'PT1H', required_finality: 'snapshot' } })]);
    await advance('2030-06-04T12:00:00Z');
    await sync([]);
    await advance('2030-06-05T12:00:00Z');
    await sync([daily({ subscription_version: 2, selector: { feed_purpose: 'pacing', period_duration: 'PT1H', required_finality: 'snapshot' } })]);

    const state = (await readPrincipal()).result.configuration.reporting_subscriptions[0];
    expect(state).toMatchObject({
      subscription_version: 2,
      state: 'active',
      accepted_at: '2030-06-03T12:00:00.000Z',
      prior_versions_count: 1,
      prior_versions: [{ subscription_version: 1, accepted_at: '2030-06-01T00:00:00.000Z', superseded_at: '2030-06-03T12:00:00.000Z' }],
      inactive_intervals: [{ deactivated_at: '2030-06-04T12:00:00.000Z', reactivated_at: '2030-06-05T12:00:00.000Z' }],
      accounts_with_exceptions_count: 0,
    });
    expect(state.prior_versions[0].configuration.selector.feed_purpose).toBe('analytics');

    const page = (await readPrincipal({ reporting_subscription_page: { subscription_id: 'analytics-daily', list: 'prior_versions' } })).result;
    expect(page.reporting_subscription_page).toMatchObject({ list: 'prior_versions', pagination: { has_more: false, total_count: 1 } });
  });

  it('rejects a reused version with new semantics, duplicates, and an unknown destination', async () => {
    await sync([daily()]);
    expect((await sync([daily({ selector: { feed_purpose: 'pacing', period_duration: 'PT1H', required_finality: 'snapshot' } })])).result)
      .toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
    expect((await sync([daily(), daily()])).result).toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
    expect((await sync([daily({ subscription_version: 3, destination: { destination_id: 'missing', path_template: '{account_id}/x' } })])).result)
      .toMatchObject({ kind: 'failed', errors: [{ code: 'INVALID_REQUEST' }] });
  });

  it('refuses the section below 3.3', async () => {
    const result = await sync([daily()], { mode: 'open', principal: 'static:buyer-a', servedAdcpVersion: '3.2' });
    expect(result.result).toMatchObject({ kind: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
  });
});

describe('reporting subscriptions: coverage', () => {
  it('owes each account-timezone day the buy overlaps, from the reference model', async () => {
    await advance('2030-06-01T00:00:00Z');
    const accountId = await openAccount();
    await sync([daily()]);
    await seedBuy(accountId, {
      media_buy_id: 'mb_daily', confirmed_at: '2030-06-01T12:00:00Z', start_time: '2030-06-02T04:00:00Z', end_time: '2030-06-10T04:00:00Z',
    });
    await advance('2030-06-12T12:00:00Z');
    const result = await view(accountId);
    expect(starts(result.records)).toEqual([
      '2030-06-02T04:00:00Z', '2030-06-03T04:00:00Z', '2030-06-04T04:00:00Z', '2030-06-05T04:00:00Z',
      '2030-06-06T04:00:00Z', '2030-06-07T04:00:00Z', '2030-06-08T04:00:00Z', '2030-06-09T04:00:00Z',
    ]);
    expect(result.records[0]).toMatchObject({
      delivery_config_id: 'analytics-daily', delivery_config_version: 1, offering_id: 'analytics-daily-account-tz',
      period: { source_timezone: 'America/New_York' }, media_buy_ids: ['mb_daily'],
    });
    expect(result.coverage).toEqual([{ subscription_id: 'analytics-daily', subscription_version: 1, status: 'active', excluded: [] }]);

    const response = getReportingStatusForAccount({ view: 'periods', account: { account_id: accountId } } as never, 'static:buyer-a', accountId, result as never);
    validateReliableReportingResponse(response);
    expect((response as Json).subscription_coverage).toHaveLength(1);
    expect((response as Json).periods).toHaveLength(8);
  });

  it('cuts over a timezone change at the first old-timezone boundary', async () => {
    await advance('2030-06-01T00:00:00Z');
    const accountId = await openAccount();
    await sync([daily()]);
    await seedBuy(accountId, {
      media_buy_id: 'mb_tz', confirmed_at: '2030-06-01T12:00:00Z', start_time: '2030-06-02T04:00:00Z', end_time: '2030-06-08T07:00:00Z',
    });
    await advance('2030-06-04T12:00:00Z');
    const changed = await probe({ operation: 'set_account_timezone', account_id: accountId, timezone: 'America/Los_Angeles' });
    expect(changed.simulated.timezone_cutovers).toEqual([{ offering_id: 'analytics-daily-account-tz', effective_at: '2030-06-05T04:00:00.000Z' }]);
    await advance('2030-06-10T12:00:00Z');
    const result = await view(accountId);
    expect(result.coverage[0].timezone_cutovers).toEqual([{
      previous_timezone: 'America/New_York', effective_at: '2030-06-05T04:00:00.000Z', timezone: 'America/Los_Angeles',
    }]);
    // New York days through June 4; then the stretch to Los Angeles midnight
    // (04:00Z to 07:00Z) is owed under neither; Los Angeles days from June 5.
    expect(starts(result.records)).toEqual([
      '2030-06-02T04:00:00Z', '2030-06-03T04:00:00Z', '2030-06-04T04:00:00Z',
      '2030-06-05T07:00:00Z', '2030-06-06T07:00:00Z', '2030-06-07T07:00:00Z',
    ]);
  });

  it('records a gap for a re-grant inside retention and lists the revoked account', async () => {
    await advance('2030-06-01T00:00:00Z');
    const accountId = await openAccount();
    await sync([daily()]);
    await seedBuy(accountId, {
      media_buy_id: 'mb_gap', confirmed_at: '2030-06-01T12:00:00Z', start_time: '2030-06-02T04:00:00Z', end_time: '2030-06-20T04:00:00Z',
    });
    await advance('2030-06-05T12:00:00Z');
    await probe({ operation: 'revoke_grant', account_id: accountId });
    const revoked = (await readPrincipal()).result.configuration.reporting_subscriptions[0];
    expect(revoked).toMatchObject({
      accounts_unauthorized_count: 1,
      accounts_unauthorized: [{ account_id: accountId, unauthorized_at: '2030-06-05T12:00:00.000Z', last_owed_period_end: '2030-06-05T04:00:00Z', withheld_period_count: 3 }],
    });
    await advance('2030-06-08T13:00:00Z');
    await probe({ operation: 'regrant', account_id: accountId });
    await advance('2030-06-12T12:00:00Z');
    const result = await view(accountId);
    expect(result.coverage[0].gaps).toEqual([{ from: '2030-06-05T04:00:00.000Z', until: '2030-06-09T04:00:00.000Z', reason: 'unauthorized' }]);
    expect(starts(result.records)).toEqual([
      '2030-06-02T04:00:00Z', '2030-06-03T04:00:00Z', '2030-06-04T04:00:00Z',
      '2030-06-09T04:00:00Z', '2030-06-10T04:00:00Z', '2030-06-11T04:00:00Z',
    ]);
    // Withheld periods are due at the re-grant plus the SLA.
    expect(result.records[2].expected_at).toBe('2030-06-08T17:00:00.000Z');
  });

  it('admits at most max_accounts, in authorized_at order, and keeps admission sticky', async () => {
    await advance('2030-06-01T00:00:00Z');
    const accounts: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      accounts.push(await openAccount());
      await advance(`2030-06-01T0${index + 1}:00:00Z`);
    }
    await sync([daily()]);
    const waiting = await view(accounts[3]!);
    expect(waiting.coverage[0]).toMatchObject({ status: 'excluded', excluded: [{ reason: 'capacity' }] });
    await advance('2030-06-03T12:00:00Z');
    await probe({ operation: 'revoke_grant', account_id: accounts[0]! });
    const admitted = await view(accounts[3]!);
    expect(admitted.coverage[0]).toMatchObject({ status: 'active' });
    expect(admitted.coverage[0].excluded[0]).toMatchObject({ reason: 'capacity', until: '2030-06-04T04:00:00.000Z' });
  });

  it('agrees with the reference model fed only the wire state', async () => {
    await advance('2030-06-01T00:00:00Z');
    const accountId = await openAccount();
    await sync([daily()]);
    await seedBuy(accountId, {
      media_buy_id: 'mb_wire', confirmed_at: '2030-06-01T12:00:00Z', start_time: '2030-06-02T04:00:00Z', end_time: '2030-06-06T04:00:00Z',
    });
    await advance('2030-06-03T00:00:00Z');
    await sync([daily({ subscription_version: 2, selector: { feed_purpose: 'pacing', period_duration: 'PT1H', required_finality: 'snapshot' } })]);
    await advance('2030-06-07T00:00:00Z');
    const seller = await view(accountId);
    const principal = (await readPrincipal()).result.configuration.reporting_subscriptions[0];
    const buyer = expectedSubscriptionPeriods({
      subscription_id: 'analytics-daily',
      versions: [
        ...principal.prior_versions.map((version: Json) => version).reverse(),
        { subscription_version: principal.subscription_version, accepted_at: principal.accepted_at, configuration: principal.configuration },
      ],
      account: { account_id: accountId, timezone: 'America/New_York', grants: [{ authorized_at: '2030-06-01T00:00:00.000Z' }] },
      buys: [{
        media_buy_id: 'mb_wire', confirmed_at: '2030-06-01T12:00:00Z', start_time: '2030-06-02T04:00:00Z', end_time: '2030-06-06T04:00:00Z',
        packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: buildCatalog()[0]!.product.reporting_capabilities!.reporting_delivery_offering_ids! }],
      }],
      offerings: (await import('../../src/training-agent/reporting-subscriptions.js')).subscriptionOfferings(),
      coverage: seller.coverage[0],
      now: '2030-06-07T00:00:00Z',
    } as never);
    expect(seller.records.map((record: Json) => [record.delivery_config_version, record.offering_id, record.period.start, record.period.end]))
      .toEqual(buyer.expected_obligations.map(obligation => [obligation.subscription_version, obligation.offering_id, obligation.period_start, obligation.period_end]));
    // Daily to hourly: the version change at 00:00Z falls mid-day in New York,
    // so the daily period it interrupts is owed in full and hourly periods
    // start at its end.
    expect(seller.records.some((record: Json) => record.delivery_config_version === 2)).toBe(true);
  });
});

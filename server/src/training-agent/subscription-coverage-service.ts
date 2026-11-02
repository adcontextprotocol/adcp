/**
 * Glue between the training agent's stores and the reporting-subscription
 * coverage rule (reporting-subscriptions.ts): it gathers, for the
 * authenticated caller, exactly what a buyer reads from the wire — the
 * subscriptions and destinations (get_principal), each account's grant,
 * timezone, and timezone changes (list_accounts and the sandbox), and the
 * confirmed buys with their packages' offerings (get_media_buys) — and asks
 * the coverage rule for exceptions and owed periods.
 */
import { trainingCallerPrincipal } from './agent-notification-configs.js';
import {
  callerAccountAttributes,
  callerAccountRef,
  callerAccountStates,
  type CallerAccountState,
} from './account-handlers.js';
import { ensureGrant, grantFor, loadSandbox, sandboxNowIso, sandboxNowMs, timezoneChangesFor } from './account-sandbox.js';
import { activeAccountReportingConfigs } from './reporting-reliability.js';
import {
  accountEverInScope,
  coverageForAccount,
  subscriptionObligationRecords,
  type CoverageAccount,
  type CoverageBuy,
  type CoverageContext,
  type SubscriptionAccountCoverage,
  type SubscriptionReadbackExtras,
  type SubscriptionRecord,
} from './reporting-subscriptions.js';
import { packageReportingOfferingIds } from './package-reporting-offerings.js';
import { mediaBuysVisibleForAccount } from './task-handlers.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import type { TrainingContext } from './types.js';

type Json = Record<string, unknown>;

interface PrincipalView {
  subscriptions: SubscriptionRecord[];
  destinations: Array<{ destination_id: string; destination_ref: string; pattern: string; transport: string }>;
}

/** The caller's subscriptions and destinations from its principal document. */
export async function loadPrincipalView(ctx: TrainingContext): Promise<PrincipalView> {
  const key = trainingCallerPrincipal(ctx);
  if (!key) return { subscriptions: [], destinations: [] };
  const session = await getSession(sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, key));
  const document = session.principalConfigurations.get(key) as {
    subscriptions?: SubscriptionRecord[];
    destinations?: Array<{ destination_id: string; destination_ref: string; configuration: Json }>;
  } | undefined;
  return {
    subscriptions: structuredClone(document?.subscriptions ?? []),
    destinations: (document?.destinations ?? []).map(record => ({
      destination_id: record.destination_id,
      destination_ref: record.destination_ref,
      pattern: String(record.configuration.pattern),
      transport: String(record.configuration.transport),
    })),
  };
}

/** The buys get_media_buys shows the caller for one account, in coverage shape. */
async function accountBuys(ctx: TrainingContext, state: CallerAccountState): Promise<CoverageBuy[]> {
  const buys = await mediaBuysVisibleForAccount({ account_id: state.accountId }, { ...ctx, mode: 'open' });
  const session = await getSession(sessionKeyFromArgs(
    { account: callerAccountRef(state) },
    'open',
    undefined,
    undefined,
    ctx.principal,
  ));
  const products = new Map<string, { reporting_capabilities?: unknown }>(
    [...session.configuredProducts.entries()].map(([id, product]) => [id, product as { reporting_capabilities?: unknown }]),
  );
  return buys.map(mediaBuy => ({
    media_buy_id: mediaBuy.mediaBuyId,
    confirmed_at: mediaBuy.confirmedAt ?? null,
    start_time: mediaBuy.startTime,
    end_time: mediaBuy.endTime,
    ...(mediaBuy.canceledAt && { canceled_at: mediaBuy.canceledAt }),
    packages: mediaBuy.packages.filter(pkg => !pkg.canceled).map(pkg => ({
      package_id: pkg.packageId,
      reporting_delivery_offering_ids: packageReportingOfferingIds(mediaBuy, pkg, products),
    })),
  }));
}

interface CallerCoverage {
  context: CoverageContext;
  accounts: Map<string, { state: CallerAccountState; account: CoverageAccount }>;
}

/** Everything the coverage rule needs about the caller, at its sandbox time. */
export async function callerCoverage(ctx: TrainingContext): Promise<CallerCoverage> {
  const view = await loadPrincipalView(ctx);
  const sandbox = await loadSandbox(ctx.principal);
  const nowMs = sandboxNowMs(sandbox.doc);
  const states = await callerAccountStates(ctx);
  let recorded = false;
  const accounts = new Map<string, { state: CallerAccountState; account: CoverageAccount }>();
  for (const state of states) {
    recorded = ensureGrant(sandbox.doc, state.accountId, sandboxNowIso(sandbox.doc)) || recorded;
    const grant = grantFor(sandbox.doc, state.accountId);
    // Coverage depends on get_reporting_status in the grant alone.
    const coverageGrant = grant && grant.allowed_tasks && !grant.allowed_tasks.includes('get_reporting_status')
      ? undefined
      : grant;
    const attributes = callerAccountAttributes(state);
    accounts.set(state.accountId, {
      state,
      account: {
        account_id: state.accountId,
        operator: state.operator,
        ...(attributes.timezone && { timezone: attributes.timezone }),
        grant: coverageGrant,
        timezone_changes: structuredClone(timezoneChangesFor(sandbox.doc, state.accountId)),
      },
    });
  }
  if (recorded) sandbox.save();
  return {
    accounts,
    context: {
      nowMs,
      subscriptions: view.subscriptions,
      destinations: view.destinations,
      accounts: [...accounts.values()].map(entry => entry.account),
      accountConfigs: accountId => activeAccountReportingConfigs(ctx.principal, accountId, nowMs),
    },
  };
}

export interface SubscriptionReportingView {
  nowMs: number;
  records: Json[];
  coverage: Json[];
  generations: Array<{ delivery_config_id: string; delivery_config_version: number; feed_purpose: string; offering_id: string }>;
  configIds: string[];
  mediaBuyIds: string[];
  finality: string[];
}

/** Subscription obligations and exceptions for one account, for get_reporting_status. */
export async function subscriptionReportingView(ctx: TrainingContext, accountId: string): Promise<SubscriptionReportingView | undefined> {
  const caller = await callerCoverage(ctx);
  const entry = caller.accounts.get(accountId);
  if (!entry || !accountEverInScope(caller.context.subscriptions, entry.account)) {
    return { nowMs: caller.context.nowMs, records: [], coverage: [], generations: [], configIds: [], mediaBuyIds: [], finality: [] };
  }
  const buys = await accountBuys(ctx, entry.state);
  const coverages = coverageForAccount(caller.context, entry.account, buys);
  const records = coverages.flatMap(coverage => subscriptionObligationRecords(accountId, coverage, entry.account, caller.context.nowMs));
  const generations = new Map<string, SubscriptionReportingView['generations'][number]>();
  for (const record of records) {
    const key = `${record.delivery_config_id}\u001f${record.delivery_config_version}\u001f${record.offering_id}`;
    generations.set(key, {
      delivery_config_id: String(record.delivery_config_id),
      delivery_config_version: Number(record.delivery_config_version),
      feed_purpose: String(record.feed_purpose),
      offering_id: String(record.offering_id),
    });
  }
  return {
    nowMs: caller.context.nowMs,
    records,
    coverage: coverages.flatMap(coverage => (coverage.entry ? [coverage.entry] : [])),
    generations: [...generations.values()],
    configIds: coverages.map(coverage => coverage.subscription_id),
    mediaBuyIds: buys.map(buy => buy.media_buy_id),
    finality: [...new Set(coverages.map(coverage => coverage.required_finality))],
  };
}

/** accounts_with_exceptions and accounts_unauthorized for each subscription. */
export async function subscriptionReadbackExtras(ctx: TrainingContext): Promise<Map<string, SubscriptionReadbackExtras>> {
  const caller = await callerCoverage(ctx);
  const extras = new Map<string, SubscriptionReadbackExtras>(
    caller.context.subscriptions.map(record => [record.subscription_id, { accounts_with_exceptions: [], accounts_unauthorized: [] }]),
  );
  if (caller.context.subscriptions.length === 0) return extras;
  for (const { state, account } of caller.accounts.values()) {
    if (!accountEverInScope(caller.context.subscriptions, account)) continue;
    const buys = await accountBuys(ctx, state);
    for (const coverage of coverageForAccount(caller.context, account, buys) as SubscriptionAccountCoverage[]) {
      const target = extras.get(coverage.subscription_id)!;
      if (coverage.unauthorized) {
        target.accounts_unauthorized.push({ account_id: account.account_id, ...coverage.unauthorized });
      } else if (coverage.open_reasons.length > 0 && coverage.entry) {
        target.accounts_with_exceptions.push({ account_id: account.account_id, reasons: coverage.open_reasons });
      }
    }
  }
  return extras;
}

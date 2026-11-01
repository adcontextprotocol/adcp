#!/usr/bin/env node
/**
 * TypeScript buyer for the interop matrix (tests/interop/matrix/CONTRACT.txt), on @adcp/sdk's client.
 *
 *   echo '{"url":"http://127.0.0.1:P/mcp","token":"buyer-ts", ...}' | node buyer.mjs <command>
 *
 * Commands: subscribe, unsubscribe, owed, account_open, account_refresh, account_change, account_requests.
 * `owed` reads only the wire, builds the canonical coverage input (case.schema.json input) with the
 * mapping both matrix buyers share, and computes owed periods with owedSubscriptionPeriodsV1.
 * State that must outlive one invocation (the account registry, grants observed) is a JSON file
 * under $ADCP_INTEROP_STATE_DIR, one per (sdk, token, seller url).
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const envDir = process.env.ADCP_INTEROP_ENV;
if (!envDir) throw new Error('ADCP_INTEROP_ENV is not set');
const want = process.env.ADCP_INTEROP_TZDATA;
if (want && process.versions.tz !== want && process.env.ADCP_INTEROP_ALLOW_TZDATA_MISMATCH !== '1') {
  throw new Error(`Node resolves zones from tzdata ${process.versions.tz}, not ${want}: set ICU_TIMEZONE_FILES_DIR`);
}
const sdkRequire = createRequire(path.join(envDir, 'node', 'package.json'));
const sdk = sdkRequire('@adcp/sdk');
const { owedSubscriptionPeriodsV1, reportingSubscriptionVersionRecordsV1, CoverageInputError } = sdkRequire('@adcp/sdk/reporting/advanced');

const log = (...parts) => process.stderr.write(`[ts-buyer] ${parts.join(' ')}\n`);

// ---------------------------------------------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------------------------------------------

function stateFile(url, token) {
  const dir = process.env.ADCP_INTEROP_STATE_DIR || path.join(envDir, 'buyer-state');
  mkdirSync(dir, { recursive: true });
  const digest = createHash('sha256').update(`${token}\n${url}`).digest('hex').slice(0, 16);
  return path.join(dir, `ts-${token.replace(/[^A-Za-z0-9_.-]/g, '_')}-${digest}.json`);
}
function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { accounts: {}, grants: {} };
  }
}
function saveState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** BuyerAccountStorage over the state file (one process at a time, so read-your-writes holds). */
function fileAccountStorage(state, persist) {
  return {
    async get(key) {
      return state.accounts[key] ? structuredClone(state.accounts[key]) : undefined;
    },
    async set(key, account) {
      state.accounts[key] = structuredClone(account);
      persist();
    },
    async compareAndSet(key, expectedRevision, account) {
      const current = state.accounts[key];
      if ((current === undefined && expectedRevision !== undefined) || (current !== undefined && current.revision !== expectedRevision)) return false;
      state.accounts[key] = structuredClone(account);
      persist();
      return true;
    },
    async list(scope) {
      return Object.entries(state.accounts)
        .filter(([key]) => key.startsWith(`${scope}:`))
        .map(([, value]) => structuredClone(value));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const Z = text => {
  const value = new Date(Date.parse(text)).toISOString();
  return value.endsWith('.000Z') ? `${value.slice(0, -5)}Z` : value;
};
const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortRows = rows =>
  rows.sort(
    (a, b) =>
      Date.parse(a.period_start) - Date.parse(b.period_start) ||
      a.subscription_version - b.subscription_version ||
      byteCompare(a.offering_id, b.offering_id) ||
      byteCompare(a.media_buy_id, b.media_buy_id),
  );

class TaskFailure extends Error {
  constructor(task, result) {
    const errors = result?.data?.errors ?? result?.adcpError ?? result?.error;
    super(`${task} failed: ${typeof errors === 'string' ? errors : JSON.stringify(errors)}`);
    this.details = { task, status: result?.status, error: result?.error, adcpError: result?.adcpError, errors: result?.data?.errors };
  }
}
async function data(task, promise) {
  const result = await promise;
  if (!result?.success) throw new TaskFailure(task, result);
  return result.data;
}

/** The authenticated principal state for one subscription from get_principal. */
function subscriptionStates(principal) {
  const candidates = [
    principal?.result?.configuration?.reporting_subscriptions,
    principal?.configuration?.reporting_subscriptions,
    principal?.reporting_subscriptions,
    principal?.state?.reporting_subscriptions,
    principal?.configuration?.reporting_subscription_states,
    principal?.reporting_subscription_states,
  ];
  for (const list of candidates) if (Array.isArray(list) && list.some(item => item && 'state' in item)) return list;
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------

async function owed(client, args, state) {
  const { subscription_id: subscriptionId, account_id: accountId, now } = args;
  const capabilities = await data('get_adcp_capabilities', client.executeTask('get_adcp_capabilities', {}));
  const delivery = capabilities?.media_buy?.reporting_delivery ?? {};
  const principal = await data('get_principal', client.getPrincipal({}));
  const subscriptionState = subscriptionStates(principal).find(item => item.subscription_id === subscriptionId);
  if (!subscriptionState) throw new Error(`get_principal has no state for ${subscriptionId}: ${JSON.stringify(principal).slice(0, 800)}`);
  const versions = reportingSubscriptionVersionRecordsV1({ state: subscriptionState });

  const listed = (await data('list_accounts', client.listAccounts({}))).accounts?.find(item => item.account_id === accountId);
  const memory = (state.grants[accountId] ??= {});
  for (const entry of subscriptionState.accounts_unauthorized ?? []) {
    if (entry.account_id === accountId && entry.unauthorized_at) {
      if (!memory.unauthorized_at || Date.parse(entry.unauthorized_at) > Date.parse(memory.unauthorized_at)) memory.unauthorized_at = entry.unauthorized_at;
    }
  }
  let grants;
  const U = memory.unauthorized_at;
  if (listed?.authorization?.authorized_at) {
    const auth = listed.authorization.authorized_at;
    if (U && Date.parse(U) > Date.parse(auth)) {
      grants = [{ authorized_at: auth, unauthorized_at: U }, { authorized_at: listed.authorization.regranted_at ?? auth }];
    } else if (U && memory.authorized_at && Date.parse(auth) > Date.parse(U) && Date.parse(memory.authorized_at) < Date.parse(U)) {
      grants = [{ authorized_at: memory.authorized_at, unauthorized_at: U }, { authorized_at: auth }];
    } else {
      grants = [{ authorized_at: auth }];
    }
    // Remember the chain start that preceded the latest revocation; keep the older value across a new chain.
    if (!(U && memory.authorized_at && Date.parse(auth) > Date.parse(U))) memory.authorized_at = auth;
  } else if (U && memory.authorized_at) {
    grants = [{ authorized_at: memory.authorized_at, unauthorized_at: U }];
  } else {
    grants = [];
  }

  // A revoked caller has no access, get_media_buys included; the periods owed before the revocation are
  // computed from the buys it last read (state file).
  const memoryBuys = (state.buys ??= {});
  let mediaBuys;
  if (listed) {
    mediaBuys = (await data('get_media_buys', client.getMediaBuys({ account: { account_id: accountId } }))).media_buys ?? [];
    memoryBuys[accountId] = mediaBuys;
  } else {
    mediaBuys = memoryBuys[accountId] ?? [];
  }
  const buys = mediaBuys.map(buy => ({
    media_buy_id: buy.media_buy_id,
    ...(buy.confirmed_at !== undefined ? { confirmed_at: buy.confirmed_at } : {}),
    start_time: buy.start_time,
    end_time: buy.end_time,
    ...(buy.cancellation?.canceled_at ? { canceled_at: buy.cancellation.canceled_at } : {}),
    ...(buy.cancellation_effective_at ? { cancellation_effective_at: buy.cancellation_effective_at } : {}),
    ...(buy.completed_at ? { completed_at: buy.completed_at } : {}),
    packages: (buy.packages ?? []).map(pkg => ({ package_id: pkg.package_id, reporting_delivery_offering_ids: pkg.reporting_delivery_offering_ids ?? [] })),
    ...(buy.flight_history ? { flight_history: buy.flight_history } : {}),
  }));

  // get_reporting_status treats an account the caller lost authority over as unknown.
  let status = { periods: [], subscription_coverage: [] };
  if (listed) {
    // Periods are paged (at most 100 per page); read every page of one ledger snapshot.
    status = await data('get_reporting_status', client.getReportingStatus({ account: { account_id: accountId }, view: 'periods', pagination: { max_results: 100 } }));
    const periods = [...(status.periods ?? [])];
    let cursor = status.pagination?.has_more ? status.pagination.cursor : undefined;
    while (cursor) {
      const page = await data('get_reporting_status', client.getReportingStatus({ account: { account_id: accountId }, view: 'periods', pagination: { max_results: 100, cursor } }));
      periods.push(...(page.periods ?? []));
      cursor = page.pagination?.has_more ? page.pagination.cursor : undefined;
    }
    status = { ...status, periods };
  }
  const coverageEntry = (status.subscription_coverage ?? []).find(item => item.subscription_id === subscriptionId);
  const coverage = {};
  for (const key of ['excluded', 'gaps', 'timezone_cutovers']) if (coverageEntry?.[key]?.length) coverage[key] = coverageEntry[key];

  const input = {
    subscription_id: subscriptionId,
    versions,
    account: {
      account_id: accountId,
      ...(listed?.timezone ? { timezone: listed.timezone } : {}),
      ...(listed?.operator ? { operator: listed.operator } : {}),
      grants,
    },
    buys,
    offerings: delivery.offerings ?? [],
    ...(subscriptionState.inactive_intervals?.length ? { inactive_intervals: subscriptionState.inactive_intervals } : {}),
    ...(Object.keys(coverage).length ? { coverage } : {}),
    ...(delivery.status_retention_days !== undefined ? { status_retention_days: delivery.status_retention_days } : {}),
    ...(delivery.subscriptions?.backfill_on_regrant ? { backfill_on_regrant: true } : {}),
    now,
  };

  const wireObligations = sortRows(
    (status.periods ?? [])
      .filter(item => item.delivery_config_id === subscriptionId)
      .flatMap(item =>
        (item.media_buy_ids ?? []).map(mediaBuyId => ({
          subscription_version: item.delivery_config_version,
          media_buy_id: mediaBuyId,
          offering_id: item.offering_id,
          period_start: Z(item.period?.start ?? item.period_start),
          period_end: Z(item.period?.end ?? item.period_end),
          ...(item.stub ? { stub: true } : {}),
        })),
      ),
  );

  let rows;
  if (grants.length === 0) {
    rows = []; // never granted as far as the wire shows
  } else {
    try {
      rows = sortRows(
        owedSubscriptionPeriodsV1(structuredClone(input)).map(row => ({
          subscription_version: row.subscription_version,
          media_buy_id: row.media_buy_id,
          offering_id: row.offering_id,
          period_start: Z(row.period_start),
          period_end: Z(row.period_end),
          ...(row.stub ? { stub: true } : {}),
        })),
      );
    } catch (error) {
      if (error instanceof CoverageInputError) {
        return { ok: false, error: error.message, code: error.code, detail: error.detail, input, wire_obligations: wireObligations };
      }
      throw error;
    }
  }
  return { ok: true, rows, wire_obligations: wireObligations, input };
}

function outcomeJson(outcome) {
  const out = { kind: outcome.kind, next_step: sdk.nextStep(outcome) };
  for (const key of ['account_id', 'request_id', 'status', 'via', 'resolution']) if (outcome[key] !== undefined) out[key] = outcome[key];
  if (outcome.action) out.action = { ...outcome.action };
  if (outcome.candidates) out.candidates = outcome.candidates.map(item => item.account_id);
  if (outcome.errors) out.errors = outcome.errors;
  return out;
}

const COMMANDS = {
  async subscribe(client, { subscription }) {
    const result = await client.reporting.subscribe(subscription);
    return { ok: true, action: result.action, subscription_version: result.subscriptionVersion };
  },
  async unsubscribe(client, { subscription_id }) {
    const result = await client.reporting.unsubscribe(subscription_id);
    return { ok: true, action: result.action, subscription_version: result.subscriptionVersion };
  },
  owed,
  async account_open(client, { brand, operator, billing, payment_terms }) {
    const options = {};
    if (billing) options.billing = billing;
    if (payment_terms) options.paymentTerms = payment_terms;
    const outcome = await client.accounts.ensure({ brand, operator }, options);
    return { ok: true, ...outcomeJson(outcome) };
  },
  async account_refresh(client) {
    const moved = await client.accounts.refresh();
    return { ok: true, moved: moved.map(outcomeJson) };
  },
  async account_change(client, { account_id, changes, revision }) {
    const params = { account_id, ...changes, ...(revision !== undefined ? { revision } : {}) };
    const response = await data('request_account', client.requestAccount(params));
    const record = response.request ?? {};
    const out = { ok: true, state: record.state, request_id: record.request_id };
    for (const key of ['resolution', 'account_id', 'pending_action', 'not_carried_over', 'effective_at', 'errors']) if (record[key] !== undefined) out[key] = record[key];
    return out;
  },
  async account_requests(client, { request_ids }) {
    const response = await data('list_accounts', client.listAccounts({ request_ids, include_requests: true }));
    return { ok: true, requests: response.account_requests ?? [] };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

const command = process.argv[2];
const handler = COMMANDS[command];
let reply;
try {
  if (!handler) throw new Error(`unknown command ${command}; one of ${Object.keys(COMMANDS).join(', ')}`);
  const raw = readFileSync(0, 'utf8');
  const args = raw.trim() ? JSON.parse(raw) : {};
  if (!args.url || !args.token) throw new Error('stdin needs url and token');
  const file = stateFile(args.url, args.token);
  const state = loadState(file);
  const persist = () => saveState(file, state);
  const client = new sdk.AgentClient(
    { id: `interop-${args.token}`, name: `interop ${args.token}`, agent_uri: args.url, protocol: 'mcp', auth_token: args.token },
    { accountStorage: fileAccountStorage(state, persist), accountRegistryScope: `interop:${args.token}` },
  );
  reply = await handler(client, args, state);
  persist();
} catch (error) {
  log(error?.stack ?? error);
  reply = { ok: false, error: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}), ...(error?.details ? { details: error.details } : {}) };
}
process.stdout.write(`${JSON.stringify(reply)}\n`);
process.exit(0);

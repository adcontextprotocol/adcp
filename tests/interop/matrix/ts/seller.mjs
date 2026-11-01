#!/usr/bin/env node
/**
 * TypeScript reference seller for the interop matrix (tests/interop/matrix/CONTRACT.txt), on
 * @adcp/sdk's managed reporting-subscriptions path:
 *
 *   createReliableReportingService({ storage: memoryStorage(), subscriptions: { principal, configure, ... } })
 *     .install(platform)   // accounts.list and sales.getMediaBuys are the roster and the buys
 *   createAdcpServerFromPlatform(..., { protocol: service.principals.protocol })
 *   serve(...)            // MCP streamable HTTP on 127.0.0.1
 *
 * State is in memory and the clock is virtual: every SDK clock option reads `clock.now`, which only
 * the control endpoint moves. Grants go through the SDK grant journal (service.grants.changed).
 *
 *   node seller.mjs --start 2026-09-01T00:00:00Z
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const envDir = process.env.ADCP_INTEROP_ENV;
if (!envDir) throw new Error('ADCP_INTEROP_ENV is not set');
const sdkRequire = createRequire(path.join(envDir, 'node', 'package.json'));
const server = sdkRequire('@adcp/sdk/server');
const { createReliableReportingService } = sdkRequire('@adcp/sdk/reporting/service');
const { redactedReportingSourceOfferingV1, redactedReportingSourceRequestV1 } = sdkRequire('@adcp/sdk/reporting/source');
const { memoryStorage } = sdkRequire('@adcp/sdk/storage');
const SDK_VERSION = sdkRequire('@adcp/sdk/package.json').version;

const arg = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const log = (...parts) => process.stderr.write(`[ts-seller] ${parts.join(' ')}\n`);

// ---------------------------------------------------------------------------------------------------------------
// World (CONTRACT.txt "Fixed world")
// ---------------------------------------------------------------------------------------------------------------

const TENANT = 'interop-seller';
const ACCOUNT_ID = 'acct_1';
const REPORTING_TASKS = ['get_reporting_status', 'get_media_buys', 'sync_reporting_status', 'sync_reporting_receipts'];
const STATUS_RETENTION_DAYS = 30;
const clock = { now: new Date(arg('--start') ?? '2026-09-01T00:00:00Z') };
if (Number.isNaN(clock.now.getTime())) throw new Error('--start must be an RFC 3339 instant');
const now = () => clock.now;

const world = {
  account: {
    account_id: ACCOUNT_ID,
    name: 'Acme',
    brand: { domain: 'acme.example' },
    operator: 'agency.example',
    timezone: 'America/Santiago',
    status: 'active',
  },
  /** principal -> { granted } (the journal holds the instants; this is what accounts.list shows now). */
  grants: new Map(),
  /** account_id -> media buys as get_media_buys returns them. */
  buys: new Map([[ACCOUNT_ID, []]]),
  /** request_id -> { owner, record } */
  requests: new Map(),
  /** extra accounts created by request_account */
  accounts: new Map(),
};

function deliveryOffering(offeringId, scheduleFields) {
  const contract = redactedReportingSourceOfferingV1.contract;
  return {
    offering_id: offeringId,
    feed_purpose: 'analytics',
    report_definition_id: `${contract.report_definition_id}-${offeringId}`,
    report_definition_uri: `${contract.reportDefinitionUri}/${offeringId}`,
    report_definition_sha256: contract.reportDefinitionSha256,
    reporting_profile: {
      id: contract.reportingProfile,
      version: contract.schemaVersion,
      schema_uri: contract.schemaUri,
      schema_sha256: contract.schemaSha256,
      schema_dialect: contract.schemaDialect,
      schema_ref_policy: contract.schemaRefPolicy,
      grain: redactedReportingSourceOfferingV1.grain,
      primary_keys: ['account_id', 'package_id'],
    },
    schedule: { period_duration: 'P1D', ...scheduleFields, delivery_sla: 'PT6H' },
    supported_finality: ['official'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: ['package'],
  };
}

/**
 * The SDK's redacted source offering, renamed per delivery offering and made AUTHORITATIVE: official
 * delivery finality requires an authoritative source (validateDeliveryOffering).
 */
function sourceOffering(offeringId, timezone) {
  const { cadence, publicationClass: _class, revisionSemantics: _semantics, ...source } = structuredClone(redactedReportingSourceOfferingV1);
  source.offeringId = offeringId;
  source.contract = {
    ...source.contract,
    report_definition_id: `${source.contract.report_definition_id}-${offeringId}`,
    reportDefinitionUri: `${source.contract.reportDefinitionUri}/${offeringId}`,
  };
  source.sourceTimezone = { ...source.sourceTimezone, ianaTimezone: timezone };
  return {
    ...source,
    publicationClass: 'AUTHORITATIVE',
    finalization: {
      schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
      expectedAvailabilityLag: 'PT0S',
      worstCaseAvailabilityLag: 'PT0S',
      triggerSupport: cadence.triggerSupport,
      correctionWindow: 'P1D',
      correctionPolicy: 'none',
    },
    revisionSemantics: 'official_with_declared_correction_policy',
  };
}

// CONTRACT.txt asks for off_daily_local with alignment account_timezone. ReliableReportingService refuses
// any alignment but utc and source_timezone ("cannot honor 'account_timezone' period alignment"), so the
// closest honest schedule is source_timezone pinned (period_timezone_policy fixed) to a local zone. The
// ledger also refuses a P1D source_timezone schedule in a zone whose DST transition skips or repeats
// local midnight ("cannot be expressed as lossless source-local midnight boundaries"), so the account's
// own zone (America/Santiago) cannot be used; --local-zone picks the zone, default America/New_York.
const LOCAL_ZONE = arg('--local-zone') ?? 'America/New_York';
const OFFERINGS = {
  off_daily_local: { schedule: { alignment: 'source_timezone', period_timezone_policy: 'fixed', period_timezone: LOCAL_ZONE }, timezone: LOCAL_ZONE },
  off_daily_utc: { schedule: { alignment: 'utc' }, timezone: 'UTC' },
};

// ---------------------------------------------------------------------------------------------------------------
// Identity: the bearer token is the principal.
// ---------------------------------------------------------------------------------------------------------------

const principalIdOf = ctx => {
  const clientId = ctx?.authInfo?.clientId;
  if (typeof clientId === 'string' && clientId.length > 0) return clientId;
  // The managed service reads accounts.list and getMediaBuys under a service context that names the
  // principal in callerMutationScope (and carries the authInfo snapshot once the principal has called).
  const scoped = ctx?.reportingServiceContext ? ctx.callerMutationScope?.principal_id : undefined;
  if (typeof scoped === 'string' && scoped.length > 0) return scoped;
  throw new Error('authenticated caller required');
};
const principalRef = principalId => ({ tenantId: TENANT, principalId });

// ---------------------------------------------------------------------------------------------------------------
// The managed service
// ---------------------------------------------------------------------------------------------------------------

const storage = memoryStorage({ now });
const request = redactedReportingSourceRequestV1();
const { currency: _currency, ...sourceSettings } = request.sourceSettings;

function noOutboundNotifications(store) {
  return server.createPersistentNotificationRuntime({
    store: server.principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: false }) },
    validateDestination: async () => ({ allowed: false, reason: 'the interop seller makes no outbound calls' }),
    authorizeDelivery: async () => ({ authorized: false }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        return { delivery_id: params.delivery_id, idempotency_key: params.delivery_id, attempts: 0, delivered: false, terminal: true, errors: ['outbound delivery is disabled'] };
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
}

const [constituentTemplate] = request.coverage.constituents;
const constituent = mediaBuyId => ({
  ...structuredClone(constituentTemplate),
  constituentId: `constituent-${mediaBuyId}`,
  mediaBuyId,
  productBinding: { ...structuredClone(constituentTemplate.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
});

const planningFailures = [];
const service = createReliableReportingService({
  storage,
  adapters: Object.fromEntries(
    Object.entries(OFFERINGS).map(([offeringId, spec]) => [
      offeringId,
      {
        sourceOffering: sourceOffering(offeringId, spec.timezone),
        deliveryOffering: deliveryOffering(offeringId, spec.schedule),
        // No upstream: every period is observed with zero rows.
        fetchSlice: slice => ({ reporting_period: { start: slice.start_date, end: slice.end_date }, currency: 'USD', reporting_rows: [] }),
      },
    ]),
  ),
  contact: { name: 'Reporting operations', email: 'reporting@interop-seller.example' },
  automatedRecoveryWindowSeconds: 86_400,
  statusRetentionDays: STATUS_RETENTION_DAYS,
  resolveSource: (account, configuration) => {
    const adapterId = OFFERINGS[configuration?.offeringId] ? configuration.offeringId : 'off_daily_utc';
    return { adapterId, sourceScope: { network_id: `network-${account.id}` }, sourceTimezone: OFFERINGS[adapterId].timezone };
  },
  resolveCurrency: () => 'USD',
  // The ledger needs one constituent per covered media buy; the engine's owed set names them.
  resolveCoverage: (account, configuration) => {
    const ids = configuration?.expectedMediaBuyIds?.length
      ? configuration.expectedMediaBuyIds
      : (world.buys.get(account.id) ?? []).map(buy => buy.media_buy_id);
    return { constituents: ids.map(constituent) };
  },
  resolveConsumerId: context => principalIdOf(context),
  subscriptions: {
    principal: {
      notifications: noOutboundNotifications(storage.principals),
      agentUrl: 'https://interop-seller.example/mcp',
      resolvePrincipal: ctx => ({ tenant_id: TENANT, principal_id: principalIdOf(ctx), principal_kind: 'buyer_agent' }),
      issuePrincipalId: () => `principal-${randomUUID()}`,
      issueConfigurationVersion: () => `cfg-${randomUUID()}`,
      now,
      includeCompatibilityNotificationTask: true,
    },
    resolvePrincipal: ctx => principalRef(principalIdOf(ctx)),
    tenants: [TENANT],
    maxAccounts: 100,
    dimensions: ['package'],
    accountConfiguration: false,
    // Official finality needs a pinned finality policy; the source is authoritative and final at publication.
    configure: () => ({
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      sourceSettings,
      finalityPolicy: { policyId: 'interop-source-final', basis: 'source_final', sourceSignal: 'published' },
    }),
    planningErrorHandler: failure => {
      planningFailures.push(failure);
      log('planning failure', failure.principal?.principalId, failure.accountId ?? '', String(failure.error?.code ?? ''), String(failure.error?.message ?? failure.error));
    },
    now,
  },
});

/** What list_accounts shows a principal now: acct_1 while granted, with the reporting tasks. */
function accountsFor(principalId) {
  const items = [];
  if (world.grants.get(principalId)?.granted) {
    items.push({
      account_id: ACCOUNT_ID,
      id: ACCOUNT_ID,
      name: world.account.name,
      brand: world.account.brand,
      operator: world.account.operator,
      status: world.account.status,
      timezone: world.account.timezone,
      ctx_metadata: {},
      authorization: { allowed_tasks: REPORTING_TASKS },
    });
  }
  for (const extra of world.accounts.values()) if (extra.owner === principalId) items.push({ ...extra.account, id: extra.account.account_id, ctx_metadata: {} });
  return items;
}

const platform = service.install({
  capabilities: {
    specialisms: [],
    config: {},
    // account.requests: the SDK registers request_account but does not advertise it from the platform path.
    overrides: {
      account: {
        requests: {
          supported: true,
          request_task: 'request_account',
          read_task: 'list_accounts',
          changeable_attributes: ['billing', 'payment_terms', 'currency', 'timezone'],
          pending_action_kinds: ['accept_terms', 'review'],
        },
      },
      experimental_features: ['account.requests'],
    },
    capability_changes: {
      capabilities_version: 'interop-1',
      cache_ttl_seconds: 3600,
      notifications: { supported: true, registration_task: 'sync_principal', event_types: ['capabilities.changed'] },
    },
  },
  accounts: {
    resolution: 'explicit',
    resolve: async (ref, ctx) => {
      if (ref?.account_id === ACCOUNT_ID) return { id: ACCOUNT_ID, name: world.account.name, status: 'active', ctx_metadata: {} };
      const extra = ref?.account_id ? world.accounts.get(ref.account_id) : undefined;
      return extra ? { id: extra.account.account_id, name: extra.account.name, status: extra.account.status, ctx_metadata: {} } : null;
    },
    upsert: async () => [],
    list: async (_filter, ctx) => ({ items: accountsFor(principalIdOf(ctx)) }),
  },
  sales: {
    getMediaBuys: async (req, ctx) => {
      const accountId = req?.account?.account_id ?? ctx?.account?.id ?? ACCOUNT_ID;
      const principalId = principalIdOf(ctx);
      if (accountId === ACCOUNT_ID && !world.grants.get(principalId)?.granted) return { media_buys: [] };
      let buys = world.buys.get(accountId) ?? [];
      if (Array.isArray(req?.media_buy_ids) && req.media_buy_ids.length) buys = buys.filter(b => req.media_buy_ids.includes(b.media_buy_id));
      return { media_buys: structuredClone(buys) };
    },
  },
});

// list_accounts include_requests: the platform path serves only accounts.list items, so the caller's account
// requests are appended where the installed reporting platform already post-processes the response.
{
  const project = platform.reporting.projectListAccounts?.bind(platform.reporting);
  platform.reporting.projectListAccounts = async (filter, response, ctx) => {
    const projected = project ? await project(filter, response, ctx) : response;
    if (!filter?.include_requests && !filter?.request_ids) return projected;
    const owner = principalIdOf(ctx);
    const wanted = Array.isArray(filter.request_ids) ? new Set(filter.request_ids) : undefined;
    const requests = [...world.requests.values()]
      .filter(entry => entry.owner === owner && (!wanted || wanted.has(entry.record.request_id)))
      .map(entry => structuredClone(entry.record));
    return { ...projected, account_requests: requests };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// request_account (CONTRACT.txt): scripted outcomes
// ---------------------------------------------------------------------------------------------------------------

const iso = () => clock.now.toISOString();
const accountWire = account => structuredClone(account);

function newRecord(owner, requested, fields) {
  const record = { request_id: `req_${randomUUID().slice(0, 12)}`, requested, created_at: iso(), updated_at: iso(), ...fields };
  world.requests.set(record.request_id, { owner, record, key: requestKey(requested) });
  return record;
}
function requestKey(requested) {
  return JSON.stringify(requested.account_id ? ['change', requested.account_id, Object.keys(requested).sort()] : ['open', requested.brand?.domain, requested.brand?.brand_id ?? null, requested.operator]);
}
function createAccount(owner, requested, overrides = {}) {
  const accountId = `acct_${randomUUID().slice(0, 8)}`;
  const account = {
    account_id: accountId,
    name: `${requested.brand?.domain ?? 'acme.example'} account`,
    brand: requested.brand ?? world.account.brand,
    operator: requested.operator ?? world.account.operator,
    status: 'active',
    timezone: requested.timezone ?? 'UTC',
    ...(requested.currency ? { currency: requested.currency } : {}),
    revision: 1,
    ...overrides,
  };
  world.accounts.set(accountId, { owner, account });
  return account;
}
const pendingAction = waitingOn =>
  waitingOn === 'buyer'
    ? { waiting_on: 'buyer', kind: 'accept_terms', url: 'https://interop-seller.example/terms', message: 'A person at the advertiser must accept the terms.' }
    : { waiting_on: 'seller', kind: 'review', message: 'The seller is reviewing the change.' };
const acct1 = () => ({ ...accountWire(world.account), revision: world.account.revision ?? 1 });

async function requestAccount(params, ctx) {
  const owner = principalIdOf(ctx);
  const { idempotency_key: _key, adcp_version: _v, adcp_major_version: _m, context: _c, ext: _e, ...body } = params ?? {};
  // Continue or read an own request.
  if (body.request_id && !body.brand && Object.keys(body).every(k => ['request_id', 'account_id'].includes(k))) {
    const entry = world.requests.get(body.request_id);
    if (!entry || entry.owner !== owner) return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'unknown request' }] };
    if (body.account_id && entry.record.state === 'ambiguous') {
      const chosen = body.account_id === ACCOUNT_ID ? acct1() : world.accounts.get(body.account_id)?.account;
      Object.assign(entry.record, { state: 'resolved', resolution: 'matched', account_id: body.account_id, account: chosen, updated_at: iso() });
      delete entry.record.candidates;
    }
    return { request: entry.record };
  }
  const requested = structuredClone(body);
  // A repeat request for the same key returns the open request.
  const key = requestKey(requested);
  for (const entry of world.requests.values()) {
    if (entry.owner === owner && entry.key === key && ['in_review', 'ambiguous'].includes(entry.record.state)) return { request: entry.record };
  }
  if (requested.account_id) {
    // change
    const changes = Object.keys(requested).filter(k => !['account_id', 'revision', 'allow_separate_account'].includes(k));
    if (changes.includes('sandbox')) {
      return { request: newRecord(owner, requested, { state: 'rejected', errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'sandbox cannot be changed on an existing account' }] }) };
    }
    if (changes.includes('billing') || changes.includes('payment_terms') || changes.includes('billing_entity')) {
      return { request: newRecord(owner, requested, { state: 'in_review', pending_action: pendingAction('seller') }) };
    }
    if (changes.includes('currency')) {
      const account = createAccount(owner, { ...world.account, ...requested, brand: world.account.brand, operator: world.account.operator });
      return {
        request: newRecord(owner, requested, {
          state: 'resolved',
          resolution: 'created',
          account_id: account.account_id,
          account,
          not_carried_over: ['notification_configs', 'reporting_delivery_configs'],
        }),
      };
    }
    if (changes.includes('timezone')) {
      if (requested.account_id === ACCOUNT_ID) {
        world.account.timezone = requested.timezone;
        world.account.revision = (world.account.revision ?? 1) + 1;
      }
      const account = requested.account_id === ACCOUNT_ID ? acct1() : world.accounts.get(requested.account_id)?.account;
      return { request: newRecord(owner, requested, { state: 'resolved', resolution: 'updated', account_id: requested.account_id, account }) };
    }
    return { request: newRecord(owner, requested, { state: 'rejected', errors: [{ code: 'INVALID_REQUEST', message: `unscripted change ${changes.join(',')}` }] }) };
  }
  const domain = requested.brand?.domain;
  switch (domain) {
    case 'review.example':
      return { request: newRecord(owner, requested, { state: 'in_review', pending_action: pendingAction('buyer') }) };
    case 'ready.example': {
      const account = createAccount(owner, requested);
      return { request: newRecord(owner, requested, { state: 'resolved', resolution: 'created', account_id: account.account_id, account }) };
    }
    case 'acme.example':
      return { request: newRecord(owner, requested, { state: 'resolved', resolution: 'matched', account_id: ACCOUNT_ID, account: acct1() }) };
    case 'ambiguous.example': {
      // account-request-record.json: candidates has minItems 2, so a second caller-visible account is listed.
      let second = [...world.accounts.values()].find(entry => entry.owner === owner && entry.account.name === 'Acme Europe')?.account;
      second ??= createAccount(owner, { brand: world.account.brand, operator: world.account.operator }, { name: 'Acme Europe' });
      return {
        request: newRecord(owner, requested, {
          state: 'ambiguous',
          candidates: [
            { account_id: ACCOUNT_ID, name: world.account.name, brand: world.account.brand, operator: world.account.operator },
            { account_id: second.account_id, name: second.name, brand: second.brand, operator: second.operator },
          ],
        }),
      };
    }
    case 'reject.example':
    default:
      return { request: newRecord(owner, requested, { state: 'rejected', errors: [{ code: 'ACCOUNT_NOT_ELIGIBLE', message: `brand ${domain} is not eligible` }] }) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------------------------------------------

const adcpServer = server.createAdcpServerFromPlatform(platform, {
  name: 'interop-ts-seller',
  version: SDK_VERSION,
  protocol: service.principals.protocol,
  accounts: { requestAccount },
  // Without a store the server advertises idempotency.supported false; a real seller replays keys.
  idempotency: server.createIdempotencyStore({ backend: server.memoryBackend(), ttlSeconds: 86_400 }),
  validation: { requests: 'strict', responses: 'strict' },
});

const authenticate = server.verifyApiKey({ verify: token => (token ? { principal: token } : null) });

// ---------------------------------------------------------------------------------------------------------------
// Control endpoint
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

const engine = () => service.subscriptionWiring.engine;

const control = {
  async set_time({ at }) {
    const next = new Date(at);
    if (Number.isNaN(next.getTime())) throw new Error('at must be an instant');
    clock.now = next;
    return {};
  },
  async grant({ principal, account_id, at }) {
    if (account_id !== ACCOUNT_ID) throw new Error(`unknown account ${account_id}`);
    world.grants.set(principal, { granted: true });
    await service.grants.changed({
      principal: principalRef(principal),
      accountId: account_id,
      at,
      authorized: true,
      allowedTasks: REPORTING_TASKS,
      timezone: world.account.timezone,
      operator: world.account.operator,
    });
    return {};
  },
  async revoke({ principal, account_id, at }) {
    if (account_id !== ACCOUNT_ID) throw new Error(`unknown account ${account_id}`);
    world.grants.set(principal, { granted: false });
    await service.grants.changed({ principal: principalRef(principal), accountId: account_id, at, authorized: false });
    return {};
  },
  async put_buy({ account_id, buy: given }) {
    // Fill the media-buy fields get_media_buys requires that the contract leaves to the seller.
    const buy = { status: 'active', currency: 'USD', total_budget: 1000, revision: 1, ...given };
    const list = world.buys.get(account_id) ?? [];
    const index = list.findIndex(item => item.media_buy_id === buy.media_buy_id);
    if (index === -1) list.push(structuredClone(buy));
    else list[index] = structuredClone(buy);
    world.buys.set(account_id, list);
    return {};
  },
  async run_cycle() {
    const before = planningFailures.length;
    const result = await service.runCycle({ deploymentWide: true, now: clock.now });
    const errors = [...(result.subscriptionPlanningFailures ?? []), ...planningFailures.slice(before)].map(failure => ({
      principal: failure.principal?.principalId,
      account_id: failure.accountId,
      subscription_id: failure.subscriptionId,
      code: failure.error?.code,
      message: String(failure.error?.message ?? failure.error),
    }));
    return { planned: result.planned, failed: result.failed, errors };
  },
  async obligations({ principal, account_id, subscription_id }) {
    // The engine's own owed set for (principal, subscription, account), not a wire recomputation.
    const owed = await engine().owedPeriods(principalRef(principal), account_id, { now: clock.now.toISOString() });
    return {
      rows: sortRows(
        owed.filter(row => row.subscription_id === subscription_id).map(row => ({
          subscription_version: row.subscription_version,
          media_buy_id: row.media_buy_id,
          offering_id: row.offering_id,
          period_start: Z(row.period_start),
          period_end: Z(row.period_end),
          ...(row.stub ? { stub: true } : {}),
        })),
      ),
    };
  },
  async account_request({ request_id, action }) {
    const entry = world.requests.get(request_id);
    if (!entry) throw new Error(`unknown request ${request_id}`);
    if (entry.record.state !== 'in_review') throw new Error(`request ${request_id} is ${entry.record.state}`);
    const record = entry.record;
    delete record.pending_action;
    record.updated_at = iso();
    if (action === 'reject') {
      Object.assign(record, { state: 'rejected', errors: [{ code: 'ACCOUNT_NOT_ELIGIBLE', message: 'the seller declined the request' }] });
    } else if (record.requested.account_id) {
      // a billing change approved: updated, effective now
      const target = record.requested.account_id === ACCOUNT_ID ? world.account : world.accounts.get(record.requested.account_id)?.account;
      for (const key of ['billing', 'payment_terms']) if (record.requested[key] !== undefined && target) target[key] = record.requested[key];
      if (target) target.revision = (target.revision ?? 1) + 1;
      Object.assign(record, {
        state: 'resolved',
        resolution: 'updated',
        account_id: record.requested.account_id,
        account: record.requested.account_id === ACCOUNT_ID ? acct1() : structuredClone(target),
        effective_at: iso(),
      });
    } else {
      const account = createAccount(entry.owner, record.requested);
      Object.assign(record, { state: 'resolved', resolution: 'created', account_id: account.account_id, account });
    }
    return { request: record };
  },
  async state() {
    return { now: clock.now.toISOString(), grants: Object.fromEntries(world.grants), buys: Object.fromEntries(world.buys), requests: [...world.requests.values()].map(e => e.record) };
  },
};

const controlServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  let reply;
  try {
    const message = JSON.parse(body || '{}');
    const handler = control[message.op];
    if (!handler) throw new Error(`unknown op ${message.op}`);
    reply = { ok: true, ...(await handler(message)) };
  } catch (error) {
    log('control error', error?.stack ?? error);
    reply = { ok: false, error: String(error?.message ?? error), code: error?.code };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply));
});

// ---------------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------------

const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const controlPort = await listen(controlServer);
let mcpUrl;
const httpServer = server.serve(() => adcpServer, {
  port: 0,
  host: '127.0.0.1',
  authenticate,
  reuseAgent: true,
  onListening: url => {
    mcpUrl = url;
  },
});
await new Promise(resolve => (httpServer.listening ? resolve() : httpServer.once('listening', resolve)));
const port = httpServer.address().port;
mcpUrl = `http://127.0.0.1:${port}/mcp`;
process.stdout.write(`${JSON.stringify({ ready: true, sdk: 'ts', sdk_version: SDK_VERSION, mcp: mcpUrl, control: `http://127.0.0.1:${controlPort}/control` })}\n`);

const shutdown = () => {
  controlServer.close();
  httpServer.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

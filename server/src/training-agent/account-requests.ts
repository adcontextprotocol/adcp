/**
 * Experimental account requests (`account.requests`, AdCP 3.3) for the
 * training agent: `request_account`, the `account_requests[]` read on
 * `list_accounts`, and the caller-anchored `account_request.changed` webhook.
 *
 * A request is its own object, scoped to the authenticated caller. No account
 * exists until the request resolves, so the agent never issues a provisional
 * account_id. Accounts are opened and changed through the same store
 * sync_accounts uses (account-handlers.ts), so a resolved account is an
 * ordinary account on every other task.
 *
 * Deterministic seller policy, so storyboards can drive every outcome. Like
 * the billing convention in account-billing-relationships.ts, it keys on the
 * request's operator domain and on which attributes a change names:
 *
 * Opening (brand + operator):
 * - operator ending `-review.example`: `in_review`, waiting on the seller
 *   (`review`). The seller resolves it as `created` one hour later on the
 *   caller's sandbox clock (`reporting_subscription_probe` `advance_time`).
 * - operator ending `-signup.example`: `in_review`, waiting on the buyer
 *   (`sign_up`, expiring after seven days). The buyer completes it by sending
 *   the `request_id` with the `account_id` of an account it holds: `matched`.
 * - operator ending `-declined.example`: `rejected`.
 * - otherwise the seller resolves at once: `matched` when the caller already
 *   holds exactly one account for the brand and operator (attributes in the
 *   request narrow the match), `ambiguous` with `candidates` when it holds
 *   several, and `created` when it holds none.
 *
 * Changing (account_id + attributes; changeable: countries, operator_unit,
 * billing, billing_entity, payment_terms, timezone):
 * - `operator_unit`: the seller makes this change only on a separate account.
 *   With `allow_separate_account: true` it resolves `created` with a new
 *   account; without it, `rejected` with ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT.
 * - `payment_terms`: reviewed (`credit_application`), resolving `updated` one
 *   hour later unless the account's revision moved meanwhile (`CONFLICT`).
 * - `countries` that would make the account duplicate another account the
 *   caller holds: `matched` to that account, the named account untouched.
 * - otherwise applied at once: `updated`, with a new revision. Money changes
 *   (billing, billing_entity, payment_terms) take effect at the next UTC
 *   calendar-month boundary (`effective_at`). A timezone change is recorded as
 *   a reporting cutover.
 * - `currency` and `sandbox` never change (UNSUPPORTED_FEATURE).
 */
import { randomUUID } from 'node:crypto';
import {
  callerAccountAttributes,
  callerAccountStates,
  callerAccountWire,
  findCallerAccount,
  openCallerAccount,
  recordCallerAccountGrant,
  SUPPORTED_BILLINGS,
  updateCallerAccount,
  type CallerAccountState,
  type OpenCallerAccountInput,
} from './account-handlers.js';
import { isPerAccountBillingRestricted } from './account-billing-relationships.js';
import {
  grantPermits,
  isIanaTimezone,
  isRevoked,
  loadSandbox,
  recordTimezoneChange,
  sandboxNowIso,
  sandboxNowMs,
  type SandboxDocument,
} from './account-sandbox.js';
import { agentNotificationDocumentId, trainingCallerPrincipal } from './agent-notification-configs.js';
import { getAgentUrl, TRAINING_AGENT_URL } from './config.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import { emitAccountNotificationWebhook } from './webhooks.js';
import type { SessionState, ToolArgs, TrainingContext } from './types.js';
import { supportsAccountSurfaces33 } from './types.js';

type Json = Record<string, unknown>;
type RequestState = 'in_review' | 'resolved' | 'ambiguous' | 'rejected';
type Resolution = 'matched' | 'created' | 'updated';

export const ACCOUNT_REQUESTS_FEATURE = 'account.requests';
export const ACCOUNT_REQUEST_CHANGED = 'account_request.changed';
const REQUESTS_DOC_PREFIX = 'account_requests\u001f';
const REVIEW_DELAY_MS = 60 * 60 * 1000;
const SIGN_UP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_CALLER = 500;
const SUPPORTED_PAYMENT_TERMS = ['net_15', 'net_30', 'net_45', 'net_60', 'net_90', 'prepay'];

export const CHANGEABLE_ATTRIBUTES = [
  'countries',
  'operator_unit',
  'billing',
  'billing_entity',
  'payment_terms',
  'timezone',
] as const;

/** `account.requests` capability block advertised on the 3.3 wire. */
export const ACCOUNT_REQUESTS_CAPABILITY = {
  supported: true,
  request_task: 'request_account',
  read_task: 'list_accounts',
  changeable_attributes: [...CHANGEABLE_ATTRIBUTES],
  event_type: ACCOUNT_REQUEST_CHANGED,
  pending_action_kinds: ['review', 'sign_up', 'credit_application'],
} as const;

const REVIEW_OPERATOR_SUFFIX = '-review.example';
const SIGN_UP_OPERATOR_SUFFIX = '-signup.example';
const DECLINED_OPERATOR_SUFFIX = '-declined.example';

interface OpenTerms extends OpenCallerAccountInput {}

interface ChangeTerms {
  countries?: string[];
  operator_unit?: { id: string; name?: string };
  billing?: string;
  billing_entity?: Json;
  payment_terms?: string;
  timezone?: string;
}

interface StoredRequest {
  request_id: string;
  kind: 'open' | 'change';
  state: RequestState;
  requested: Json;
  pending_action?: Json;
  account_id?: string;
  resolution?: Resolution;
  effective_at?: string;
  not_carried_over?: string[];
  candidates?: Json[];
  errors?: Json[];
  created_at: string;
  updated_at: string;
  /** Seller-driven resolution instant on the caller's sandbox clock. */
  review_due_at?: string;
  /** Terms to open when an open request resolves. */
  open?: OpenTerms;
  /** Change to apply when a change request resolves. */
  change?: ChangeTerms;
  /** The account revision a reviewed change is re-checked against. */
  base_revision?: number;
}

interface RequestsDocument extends Json {
  requests: StoredRequest[];
}

interface Loaded {
  session: SessionState;
  key: string;
  doc: RequestsDocument;
  /** Read-only view of the caller's sandbox (clock, revocations). Writes load
   * the sandbox afresh so concurrent writers in one request never overwrite
   * each other. */
  sandbox: Awaited<ReturnType<typeof loadSandbox>>;
}

class RequestFailure extends Error {
  constructor(readonly error: Json) {
    super(String(error.message));
  }
}

function fail(code: string, message: string, extra: Json = {}): never {
  throw new RequestFailure({ code, message, recovery: 'correctable', ...extra });
}

function caller(ctx: TrainingContext): string {
  return ctx.principal && ctx.principal.length > 0 ? ctx.principal : 'anonymous';
}

async function loadRequests(ctx: TrainingContext): Promise<Loaded> {
  const principal = caller(ctx);
  const session = await getSession(sessionKeyFromArgs({}, 'open', undefined, undefined, principal));
  const key = `${REQUESTS_DOC_PREFIX}${principal}`;
  const stored = session.principalConfigurations.get(key) as RequestsDocument | undefined;
  return {
    session,
    key,
    doc: { requests: structuredClone(stored?.requests ?? []) },
    sandbox: await loadSandbox(principal),
  };
}

function saveRequests(loaded: Loaded): void {
  loaded.doc.requests = loaded.doc.requests.slice(-MAX_REQUESTS_PER_CALLER);
  loaded.session.principalConfigurations.set(loaded.key, structuredClone(loaded.doc));
}

function newRequestId(): string {
  return `areq_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function actionUrl(requestId: string): string {
  const base = getAgentUrl();
  const origin = base.startsWith('https://') ? base : TRAINING_AGENT_URL;
  return `${origin}/account-requests/${encodeURIComponent(requestId)}`;
}

function nextMonthBoundary(nowMs: number): string {
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

function withoutBank(entity: Json | undefined): Json | undefined {
  if (!entity) return undefined;
  const { bank: _bank, ...rest } = entity;
  return rest;
}

function sameCountries(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}

// ── Webhook ─────────────────────────────────────────────────────────

async function fireChanged(
  ctx: TrainingContext,
  record: StoredRequest,
  previousState: RequestState,
): Promise<void> {
  const principal = trainingCallerPrincipal(ctx);
  if (!principal) return;
  const session = await getSession(sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, principal));
  const document = session.agentNotificationConfigs.get(
    agentNotificationDocumentId({ tenant_id: 'training-agent', principal_id: principal }),
  ) as { notification_configs?: Array<{ subscriber_id: string; url: string; event_types: string[]; active?: boolean }> } | undefined;
  const subscribers = (document?.notification_configs ?? [])
    .filter(config => config.active !== false && config.event_types.includes(ACCOUNT_REQUEST_CHANGED));
  const notificationId = `arc_${record.request_id}_${record.updated_at}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
  await Promise.allSettled(subscribers.map(async subscriber => {
    const idempotencyKey = randomUUID();
    await emitAccountNotificationWebhook({
      url: subscriber.url,
      operationId: `${record.request_id}:${subscriber.subscriber_id}:${idempotencyKey}`,
      notificationType: ACCOUNT_REQUEST_CHANGED,
      payload: {
        idempotency_key: idempotencyKey,
        notification_id: notificationId,
        notification_type: ACCOUNT_REQUEST_CHANGED,
        fired_at: new Date().toISOString(),
        subscriber_id: subscriber.subscriber_id,
        agent_url: getAgentUrl(),
        request_id: record.request_id,
        previous_state: previousState,
        state: record.state,
        changed_at: record.updated_at,
      },
    });
  }));
}

// ── Seller-driven transitions ───────────────────────────────────────

function reject(record: StoredRequest, error: Json, nowIso: string): void {
  record.state = 'rejected';
  record.errors = [error];
  delete record.pending_action;
  delete record.review_due_at;
  delete record.candidates;
  delete record.account_id;
  record.updated_at = nowIso;
}

function resolve(
  record: StoredRequest,
  resolution: Resolution,
  accountId: string,
  nowIso: string,
  extra: { effective_at?: string; not_carried_over?: string[] } = {},
): void {
  record.state = 'resolved';
  record.resolution = resolution;
  record.account_id = accountId;
  delete record.pending_action;
  delete record.review_due_at;
  delete record.candidates;
  delete record.errors;
  if (extra.effective_at) record.effective_at = extra.effective_at;
  if (extra.not_carried_over) record.not_carried_over = extra.not_carried_over;
  record.updated_at = nowIso;
}

function hasMoneyChange(change: ChangeTerms): boolean {
  return change.billing !== undefined || change.billing_entity !== undefined || change.payment_terms !== undefined;
}

async function applyChange(
  ctx: TrainingContext,
  clock: SandboxDocument,
  account: CallerAccountState,
  change: ChangeTerms,
  idempotencyKey: string | undefined,
): Promise<{ effective_at?: string }> {
  const nowMs = sandboxNowMs(clock);
  const previousTimezone = callerAccountAttributes(account).timezone;
  await updateCallerAccount(ctx, account.accountId, {
    ...(change.countries !== undefined && { countries: change.countries }),
    ...(change.timezone !== undefined && { timezone: change.timezone }),
    ...(change.billing !== undefined && { billing: change.billing }),
    ...(change.billing_entity !== undefined && { billingEntity: change.billing_entity }),
    ...(change.payment_terms !== undefined && { paymentTerms: change.payment_terms }),
  }, { summary: 'Account changed through request_account.', ...(idempotencyKey && { idempotencyKey }) });
  if (change.timezone !== undefined && change.timezone !== previousTimezone) {
    // Load the sandbox afresh: account opening above records grants in it.
    const sandbox = await loadSandbox(ctx.principal);
    recordTimezoneChange(sandbox.doc, account.accountId, {
      at: new Date(nowMs).toISOString(),
      previous_timezone: previousTimezone ?? 'UTC',
      timezone: change.timezone,
    });
    sandbox.save();
  }
  return hasMoneyChange(change) ? { effective_at: nextMonthBoundary(nowMs) } : {};
}

/**
 * Process every seller-driven transition that is due on the caller's sandbox
 * clock: completed reviews and expired buyer actions. Returns the transitions
 * so the caller can fire `account_request.changed` once the state is saved.
 */
async function advanceDueRequests(
  ctx: TrainingContext,
  loaded: Loaded,
): Promise<Array<{ record: StoredRequest; previous: RequestState }>> {
  const nowMs = sandboxNowMs(loaded.sandbox.doc);
  const nowIso = new Date(nowMs).toISOString();
  const transitions: Array<{ record: StoredRequest; previous: RequestState }> = [];
  for (const record of loaded.doc.requests) {
    if (record.state !== 'in_review') continue;
    const expiresAt = record.pending_action?.expires_at;
    if (record.pending_action?.waiting_on === 'buyer' && typeof expiresAt === 'string' && Date.parse(expiresAt) <= nowMs) {
      reject(record, {
        code: 'ACCOUNT_SETUP_REQUIRED',
        message: 'The buyer action on this request expired before it was completed. Send a new request.',
        recovery: 'correctable',
      }, nowIso);
      transitions.push({ record, previous: 'in_review' });
      continue;
    }
    if (!record.review_due_at || Date.parse(record.review_due_at) > nowMs) continue;
    if (record.kind === 'open' && record.open) {
      const opened = await openCallerAccount(ctx, record.open, `areq-open-${record.request_id}`);
      if ('errors' in opened) {
        reject(record, opened.errors[0] ?? { code: 'INVALID_REQUEST', message: 'The account could not be opened.' }, nowIso);
      } else {
        await recordCallerAccountGrant(ctx.principal, opened.state.accountId);
        resolve(record, 'created', opened.state.accountId, nowIso);
      }
      transitions.push({ record, previous: 'in_review' });
      continue;
    }
    if (record.kind === 'change' && record.change && record.requested.account_id) {
      const account = await findCallerAccount(ctx, String(record.requested.account_id));
      if (!account || isRevoked(loaded.sandbox.doc, account.accountId)) {
        reject(record, { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.', recovery: 'correctable' }, nowIso);
      } else if (record.base_revision !== undefined && (account.revision ?? 1) !== record.base_revision) {
        reject(record, {
          code: 'CONFLICT',
          message: 'The account changed while this request was in review; re-read the account and send a new request.',
          recovery: 'correctable',
          field: 'revision',
        }, nowIso);
      } else {
        const applied = await applyChange(ctx, loaded.sandbox.doc, account, record.change, undefined);
        resolve(record, 'updated', account.accountId, nowIso, applied);
      }
      transitions.push({ record, previous: 'in_review' });
    }
  }
  return transitions;
}

/** Discard the caller's account requests (controller `reset_state`). */
export async function resetAccountRequests(ctx: TrainingContext): Promise<void> {
  const loaded = await loadRequests(ctx);
  loaded.session.principalConfigurations.delete(loaded.key);
}

/** Called by the sandbox clock after `advance_time`, so due transitions fire then. */
export async function advanceAccountRequestsForCaller(ctx: TrainingContext): Promise<void> {
  const loaded = await loadRequests(ctx);
  const transitions = await advanceDueRequests(ctx, loaded);
  if (transitions.length === 0) return;
  saveRequests(loaded);
  for (const { record, previous } of transitions) await fireChanged(ctx, record, previous);
}

// ── Projection ──────────────────────────────────────────────────────

async function wireRequest(ctx: TrainingContext, record: StoredRequest): Promise<Json> {
  const wire: Json = {
    request_id: record.request_id,
    state: record.state,
    requested: structuredClone(record.requested),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.state === 'in_review' && record.pending_action) wire.pending_action = structuredClone(record.pending_action);
  if (record.state === 'ambiguous' && record.candidates) wire.candidates = structuredClone(record.candidates);
  if (record.state === 'rejected' && record.errors) wire.errors = structuredClone(record.errors);
  if (record.state === 'resolved' && record.account_id) {
    wire.account_id = record.account_id;
    wire.resolution = record.resolution;
    const account = await findCallerAccount(ctx, record.account_id);
    if (account) {
      const { authorization: _authorization, reporting_delivery_configs: _configs, ...accountWire } = callerAccountWire(account);
      wire.account = accountWire;
    }
    if (record.effective_at) wire.effective_at = record.effective_at;
    if (record.not_carried_over) wire.not_carried_over = [...record.not_carried_over];
  }
  return wire;
}

function candidateFor(state: CallerAccountState): Json {
  const wire = callerAccountWire(state);
  return {
    account_id: state.accountId,
    name: wire.name,
    brand: wire.brand,
    operator: wire.operator,
    ...(wire.currency !== undefined && { currency: wire.currency }),
  };
}

// ── request_account ─────────────────────────────────────────────────

const CHANGE_FIELDS = ['brand', 'operator_unit', 'currency', 'timezone', 'sandbox', 'billing', 'billing_entity', 'payment_terms'] as const;

interface RequestAccountArgs {
  idempotency_key?: string;
  account_id?: string;
  request_id?: string;
  revision?: number;
  allow_separate_account?: boolean;
  brand?: { domain?: string; brand_id?: string; countries?: string[] };
  operator?: string;
  operator_unit?: { id: string; name?: string };
  currency?: string;
  timezone?: string;
  sandbox?: boolean;
  billing?: string;
  billing_entity?: Json;
  payment_terms?: string;
}

function requestedEcho(args: RequestAccountArgs): Json {
  return {
    ...(args.account_id !== undefined && { account_id: args.account_id }),
    ...(args.revision !== undefined && { revision: args.revision }),
    ...(args.brand !== undefined && { brand: structuredClone(args.brand) }),
    ...(args.operator !== undefined && { operator: args.operator }),
    ...(args.operator_unit !== undefined && { operator_unit: structuredClone(args.operator_unit) }),
    ...(args.currency !== undefined && { currency: args.currency }),
    ...(args.timezone !== undefined && { timezone: args.timezone }),
    ...(args.sandbox !== undefined && { sandbox: args.sandbox }),
    ...(args.billing !== undefined && { billing: args.billing }),
    ...(args.billing_entity !== undefined && { billing_entity: withoutBank(args.billing_entity) }),
    ...(args.payment_terms !== undefined && { payment_terms: args.payment_terms }),
  };
}

function validateTerms(args: RequestAccountArgs, operator: string | undefined): void {
  if (args.billing !== undefined && !(SUPPORTED_BILLINGS as readonly string[]).includes(args.billing)) {
    fail('BILLING_NOT_SUPPORTED', `Billing model '${args.billing}' is not supported by this seller.`, {
      field: 'billing',
      details: { scope: 'capability', supported_billing: [...SUPPORTED_BILLINGS] },
    });
  }
  if (args.billing !== undefined && operator && isPerAccountBillingRestricted(operator, args.billing)) {
    fail('BILLING_NOT_SUPPORTED', `Operator '${operator}' has no direct billing relationship for '${args.billing}' billing.`, {
      field: 'billing',
      details: { scope: 'account', supported_billing: [...SUPPORTED_BILLINGS] },
    });
  }
  if (args.payment_terms !== undefined && !SUPPORTED_PAYMENT_TERMS.includes(args.payment_terms)) {
    fail('PAYMENT_TERMS_NOT_SUPPORTED', `Payment terms '${args.payment_terms}' are not available.`, { field: 'payment_terms' });
  }
  if (args.timezone !== undefined && !isIanaTimezone(args.timezone)) {
    fail('INVALID_REQUEST', 'timezone must be an IANA timezone name.', { field: 'timezone' });
  }
}

function matchesOpen(state: CallerAccountState, args: RequestAccountArgs): boolean {
  const attributes = callerAccountAttributes(state);
  if (attributes.domain !== args.brand?.domain || attributes.operator !== args.operator) return false;
  if ((attributes.brand_id ?? undefined) !== (args.brand?.brand_id ?? undefined)) return false;
  // Attributes in the request narrow the match; they are filters, not identity.
  if (args.brand?.countries !== undefined && !sameCountries(attributes.countries, args.brand.countries)) return false;
  if (args.operator_unit !== undefined && attributes.operator_unit_id !== args.operator_unit.id) return false;
  if (args.currency !== undefined && attributes.currency !== args.currency) return false;
  if (args.timezone !== undefined && attributes.timezone !== args.timezone) return false;
  return attributes.sandbox === (args.sandbox === true);
}

async function handleOpen(
  ctx: TrainingContext,
  loaded: Loaded,
  args: RequestAccountArgs,
  nowIso: string,
): Promise<StoredRequest> {
  if (!args.brand?.domain) fail('INVALID_REQUEST', 'brand.domain is required to open an account.', { field: 'brand' });
  if (!args.operator) fail('INVALID_REQUEST', 'operator is required to open an account.', { field: 'operator' });
  validateTerms(args, args.operator);
  const operator = args.operator!;
  const record: StoredRequest = {
    request_id: newRequestId(),
    kind: 'open',
    state: 'in_review',
    requested: requestedEcho(args),
    created_at: nowIso,
    updated_at: nowIso,
  };
  const open: OpenTerms = {
    brand: structuredClone(args.brand) as OpenTerms['brand'],
    operator,
    ...(args.operator_unit && { operator_unit: structuredClone(args.operator_unit) }),
    ...(args.currency && { currency: args.currency }),
    ...(args.timezone && { timezone: args.timezone }),
    ...(args.sandbox !== undefined && { sandbox: args.sandbox }),
    billing: args.billing ?? 'operator',
    ...(args.billing_entity && { billing_entity: structuredClone(args.billing_entity) }),
    ...(args.payment_terms && { payment_terms: args.payment_terms }),
  };
  const nowMs = Date.parse(nowIso);
  if (operator.endsWith(DECLINED_OPERATOR_SUFFIX)) {
    reject(record, {
      code: 'POLICY_VIOLATION',
      message: 'The seller declined to open an account for this brand and operator.',
      recovery: 'terminal',
    }, nowIso);
    return record;
  }
  if (operator.endsWith(REVIEW_OPERATOR_SUFFIX)) {
    record.open = open;
    record.review_due_at = new Date(nowMs + REVIEW_DELAY_MS).toISOString();
    record.pending_action = {
      waiting_on: 'seller',
      kind: 'review',
      message: 'Sales operations is checking for an existing relationship with this advertiser.',
    };
    return record;
  }
  if (operator.endsWith(SIGN_UP_OPERATOR_SUFFIX)) {
    record.pending_action = {
      waiting_on: 'buyer',
      kind: 'sign_up',
      url: actionUrl(record.request_id),
      message: 'No existing relationship found. Register the operator as an advertiser, then send this request_id with the new account_id.',
      expires_at: new Date(nowMs + SIGN_UP_TTL_MS).toISOString(),
    };
    return record;
  }
  const matches = (await callerAccountStates(ctx))
    .filter(state => !isRevoked(loaded.sandbox.doc, state.accountId))
    .filter(state => matchesOpen(state, args))
    .sort((a, b) => Buffer.compare(Buffer.from(a.accountId), Buffer.from(b.accountId)));
  if (matches.length === 1) {
    resolve(record, 'matched', matches[0]!.accountId, nowIso);
    return record;
  }
  if (matches.length > 1) {
    record.state = 'ambiguous';
    record.candidates = matches.slice(0, 50).map(candidateFor);
    record.open = open;
    return record;
  }
  const opened = await openCallerAccount(ctx, open, `areq-open-${record.request_id}`);
  if ('errors' in opened) {
    const error = opened.errors[0]!;
    fail(String(error.code ?? 'INVALID_REQUEST'), String(error.message ?? 'The account could not be opened.'), {
      ...(error.field !== undefined && { field: error.field }),
      ...(error.details !== undefined && { details: error.details }),
    });
  }
  await recordCallerAccountGrant(ctx.principal, (opened as { state: CallerAccountState }).state.accountId);
  resolve(record, 'created', (opened as { state: CallerAccountState }).state.accountId, nowIso);
  return record;
}

/** Continue one of the caller's own open requests by naming an account. */
async function handleSelect(
  ctx: TrainingContext,
  loaded: Loaded,
  args: RequestAccountArgs,
  account: CallerAccountState,
  nowIso: string,
): Promise<StoredRequest> {
  if (args.request_id === undefined) {
    // Selecting an account the caller already reaches resolves at once.
    const record: StoredRequest = {
      request_id: newRequestId(),
      kind: 'change',
      state: 'in_review',
      requested: requestedEcho(args),
      created_at: nowIso,
      updated_at: nowIso,
    };
    resolve(record, 'matched', account.accountId, nowIso);
    return record;
  }
  const open = loaded.doc.requests.find(record => record.request_id === args.request_id);
  const continuable = open
    && (open.state === 'ambiguous'
      || (open.state === 'in_review' && open.pending_action?.waiting_on === 'buyer'));
  if (!continuable) fail('INVALID_REQUEST', 'request_id does not name one of your open requests.', { field: 'request_id' });
  if (open!.state === 'ambiguous' && !open!.candidates?.some(candidate => candidate.account_id === account.accountId)) {
    fail('INVALID_REQUEST', 'account_id is not one of the request candidates.', { field: 'account_id' });
  }
  // The response to the caller's own call reports the result; no webhook.
  resolve(open!, 'matched', account.accountId, nowIso);
  delete open!.open;
  return open!;
}

function separateAccountConfigs(account: CallerAccountState, wire: Json): string[] {
  // The new account starts without the named account's account-level
  // configuration; list what the buyer has to set up again.
  const missing: string[] = [];
  if (account.notificationConfigs.length > 0) missing.push('notification_configs');
  if (Array.isArray(wire.reporting_delivery_configs) && wire.reporting_delivery_configs.length > 0) {
    missing.push('reporting_delivery_configs');
  }
  if (account.governanceAgents.length > 0) missing.push('governance_agents');
  return missing;
}

async function handleChange(
  ctx: TrainingContext,
  loaded: Loaded,
  args: RequestAccountArgs,
  account: CallerAccountState,
  nowIso: string,
): Promise<{ record: StoredRequest; superseded?: StoredRequest }> {
  const attributes = callerAccountAttributes(account);
  if (args.sandbox !== undefined) fail('UNSUPPORTED_FEATURE', 'sandbox never changes after an account opens.', { field: 'sandbox' });
  if (args.currency !== undefined) {
    fail('UNSUPPORTED_FEATURE', 'This seller does not change currency after an account opens.', { field: 'currency' });
  }
  if (args.brand !== undefined) {
    if (args.brand.domain !== attributes.domain || (args.brand.brand_id ?? undefined) !== (attributes.brand_id ?? undefined)) {
      fail('INVALID_REQUEST', 'A change must name the account brand; a different brand is a different account.', { field: 'brand' });
    }
  }
  validateTerms(args, attributes.operator);
  const change: ChangeTerms = {
    ...(args.brand?.countries !== undefined && { countries: [...args.brand.countries] }),
    ...(args.operator_unit !== undefined && { operator_unit: structuredClone(args.operator_unit) }),
    ...(args.billing !== undefined && { billing: args.billing }),
    ...(args.billing_entity !== undefined && { billing_entity: structuredClone(args.billing_entity) }),
    ...(args.payment_terms !== undefined && { payment_terms: args.payment_terms }),
    ...(args.timezone !== undefined && { timezone: args.timezone }),
  };
  if (hasMoneyChange(change) && args.revision === undefined) {
    fail('INVALID_REQUEST', 'A change to billing, billing_entity, or payment_terms requires revision.', { field: 'revision' });
  }
  if (args.revision !== undefined && args.revision !== (account.revision ?? 1)) {
    fail('CONFLICT', 'revision is stale; re-read the account with list_accounts.', {
      field: 'revision',
      details: { current_revision: account.revision ?? 1 },
    });
  }

  const record: StoredRequest = {
    request_id: newRequestId(),
    kind: 'change',
    state: 'in_review',
    requested: requestedEcho(args),
    created_at: nowIso,
    updated_at: nowIso,
  };
  // A new change request supersedes this caller's open change request for
  // the same account; it never touches another caller's requests.
  const superseded = loaded.doc.requests.find(existing => existing.kind === 'change'
    && existing.state === 'in_review'
    && existing.requested.account_id === account.accountId);
  if (superseded) {
    reject(superseded, {
      code: 'CONFLICT',
      message: 'A newer change request for this account superseded this one.',
      recovery: 'correctable',
      details: { superseded_by: record.request_id },
    }, nowIso);
    delete superseded.change;
  }

  if (change.operator_unit !== undefined && change.operator_unit.id !== attributes.operator_unit_id) {
    if (args.allow_separate_account !== true) {
      reject(record, {
        code: 'ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT',
        message: 'This seller changes the operator unit only on a separate account. Resend with allow_separate_account: true, or open a new account.',
        recovery: 'correctable',
        field: 'operator_unit',
      }, nowIso);
      return { record, ...(superseded && { superseded }) };
    }
    const targetCountries = change.countries ?? attributes.countries;
    const targetTimezone = change.timezone ?? attributes.timezone;
    const existing = (await callerAccountStates(ctx))
      .filter(state => !isRevoked(loaded.sandbox.doc, state.accountId))
      .find(state => {
        const other = callerAccountAttributes(state);
        return other.domain === attributes.domain
          && (other.brand_id ?? undefined) === (attributes.brand_id ?? undefined)
          && other.operator === attributes.operator
          && other.operator_unit_id === change.operator_unit!.id
          && (other.currency ?? undefined) === (attributes.currency ?? undefined)
          && (other.timezone ?? undefined) === (targetTimezone ?? undefined)
          && other.sandbox === attributes.sandbox
          && sameCountries(other.countries, targetCountries);
      });
    if (existing) {
      // The change would duplicate an account the caller already holds.
      resolve(record, 'matched', existing.accountId, nowIso);
      return { record, ...(superseded && { superseded }) };
    }
    const wire = callerAccountWire(account);
    const opened = await openCallerAccount(ctx, {
      brand: {
        domain: attributes.domain,
        ...(attributes.brand_id !== undefined && { brand_id: attributes.brand_id }),
        ...(targetCountries.length > 0 && { countries: targetCountries }),
      },
      operator: attributes.operator,
      operator_unit: change.operator_unit,
      ...(attributes.currency !== undefined && { currency: attributes.currency }),
      ...(targetTimezone !== undefined && { timezone: targetTimezone }),
      sandbox: attributes.sandbox,
      billing: change.billing ?? account.billing,
      ...((change.billing_entity ?? account.billingEntity) && { billing_entity: change.billing_entity ?? account.billingEntity }),
      payment_terms: change.payment_terms ?? account.paymentTerms,
    }, `areq-separate-${record.request_id}`);
    if ('errors' in opened) {
      const error = opened.errors[0]!;
      fail(String(error.code ?? 'INVALID_REQUEST'), String(error.message ?? 'The separate account could not be opened.'));
    }
    const created = (opened as { state: CallerAccountState }).state;
    await recordCallerAccountGrant(ctx.principal, created.accountId);
    // The provisioning path matched an account the caller already holds.
    const resolution: Resolution = created.accountId === account.accountId ? 'updated' : 'created';
    resolve(record, resolution, created.accountId, nowIso, resolution === 'created'
      ? { not_carried_over: separateAccountConfigs(account, wire) }
      : {});
    return { record, ...(superseded && { superseded }) };
  }

  if (change.countries !== undefined && !sameCountries(change.countries, attributes.countries)) {
    const duplicate = (await callerAccountStates(ctx))
      .filter(state => state.accountId !== account.accountId && !isRevoked(loaded.sandbox.doc, state.accountId))
      .find(state => {
        const other = callerAccountAttributes(state);
        return other.domain === attributes.domain
          && (other.brand_id ?? undefined) === (attributes.brand_id ?? undefined)
          && other.operator === attributes.operator
          && (other.operator_unit_id ?? undefined) === (attributes.operator_unit_id ?? undefined)
          && (other.currency ?? undefined) === (attributes.currency ?? undefined)
          && (other.timezone ?? undefined) === ((change.timezone ?? attributes.timezone) ?? undefined)
          && other.sandbox === attributes.sandbox
          && sameCountries(other.countries, change.countries);
      });
    if (duplicate) {
      resolve(record, 'matched', duplicate.accountId, nowIso);
      return { record, ...(superseded && { superseded }) };
    }
  }

  if (change.payment_terms !== undefined && change.payment_terms !== account.paymentTerms) {
    record.change = change;
    record.base_revision = account.revision ?? 1;
    record.review_due_at = new Date(Date.parse(nowIso) + REVIEW_DELAY_MS).toISOString();
    record.pending_action = {
      waiting_on: 'seller',
      kind: 'credit_application',
      message: 'Credit is reviewing the requested payment terms. The account keeps its current terms until the review completes.',
    };
    return { record, ...(superseded && { superseded }) };
  }

  const applied = await applyChange(ctx, loaded.sandbox.doc, account, change, args.idempotency_key);
  resolve(record, 'updated', account.accountId, nowIso, applied);
  return { record, ...(superseded && { superseded }) };
}

export async function handleRequestAccount(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  const request = args as unknown as RequestAccountArgs;
  if (!supportsAccountSurfaces33(ctx.servedAdcpVersion)) {
    const error = {
      code: 'UNSUPPORTED_FEATURE',
      message: 'request_account is an experimental AdCP 3.3 task (account.requests).',
      recovery: 'correctable',
      field: 'adcp_version',
    };
    return { status: 'failed', adcp_error: error, errors: [error] };
  }
  if (ctx.mode === 'open' && ctx.principal === 'static:public:shared') {
    const error = {
      code: 'AUTH_REQUIRED',
      message: 'Account requests require a caller-unique credential; the published public test token is shared.',
      recovery: 'correctable',
    };
    return { status: 'failed', adcp_error: error, errors: [error] };
  }
  try {
    const loaded = await loadRequests(ctx);
    const due = await advanceDueRequests(ctx, loaded);
    const nowIso = sandboxNowIso(loaded.sandbox.doc);
    let record: StoredRequest;
    let superseded: StoredRequest | undefined;
    if (request.account_id !== undefined) {
      if (request.operator !== undefined) {
        fail('INVALID_REQUEST', 'Send either account_id, or brand and operator, not both.', { field: 'operator' });
      }
      // Reachability comes first, so nothing below reveals whether an
      // unreachable account exists.
      const account = isRevoked(loaded.sandbox.doc, request.account_id)
        ? undefined
        : await findCallerAccount(ctx, request.account_id);
      if (!account) {
        record = {
          request_id: newRequestId(),
          kind: 'change',
          state: 'in_review',
          requested: requestedEcho(request),
          created_at: nowIso,
          updated_at: nowIso,
        };
        reject(record, { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.', recovery: 'correctable', field: 'account_id' }, nowIso);
      } else {
        const grant = loaded.sandbox.doc.grants[account.accountId];
        if (!grantPermits(grant, 'request_account')) {
          fail('SCOPE_INSUFFICIENT', 'Your grant on this account does not include request_account.', {
            field: 'account_id',
            details: { task: 'request_account' },
          });
        }
        if (grant?.read_only === true) fail('READ_ONLY_SCOPE', 'Your grant on this account is read-only.');
        // brand with account_id changes only countries; a bare brand that names
        // the account's own brand (as test runners add) changes nothing.
        const changes = CHANGE_FIELDS.filter(field => (field === 'brand'
          ? request.brand?.countries !== undefined
            || (request.brand?.domain !== undefined && request.brand.domain !== account.brand.domain)
            || (request.brand?.brand_id ?? undefined) !== (account.brand.brand_id ?? undefined)
          : request[field] !== undefined));
        if (changes.length === 0) {
          record = await handleSelect(ctx, loaded, request, account, nowIso);
        } else {
          ({ record, superseded } = await handleChange(ctx, loaded, request, account, nowIso));
        }
      }
    } else {
      if (request.request_id !== undefined) {
        fail('INVALID_REQUEST', 'request_id continues an open request only together with account_id.', { field: 'request_id' });
      }
      record = await handleOpen(ctx, loaded, request, nowIso);
    }
    if (!loaded.doc.requests.includes(record)) loaded.doc.requests.push(record);
    saveRequests(loaded);
    for (const { record: transitioned, previous } of due) await fireChanged(ctx, transitioned, previous);
    if (superseded) await fireChanged(ctx, superseded, 'in_review');
    return { request: await wireRequest(ctx, record) };
  } catch (error) {
    if (error instanceof RequestFailure) {
      return { status: 'failed', adcp_error: error.error, errors: [error.error] };
    }
    throw error;
  }
}

// ── list_accounts: account_requests[] ───────────────────────────────

interface ListRequestsArgs {
  include_requests?: boolean;
  request_ids?: string[];
  requests_pagination?: { max_results?: number; cursor?: string };
}

export function listAccountsWantsRequests(args: ToolArgs): boolean {
  const request = args as ListRequestsArgs;
  return request.include_requests === true || request.request_ids !== undefined || request.requests_pagination !== undefined;
}

/** `account_requests[]` and `account_requests_pagination` for list_accounts. */
export async function accountRequestsForListAccounts(args: ToolArgs, ctx: TrainingContext): Promise<Json> {
  const request = args as ListRequestsArgs;
  const loaded = await loadRequests(ctx);
  const due = await advanceDueRequests(ctx, loaded);
  if (due.length > 0) {
    saveRequests(loaded);
    for (const { record, previous } of due) await fireChanged(ctx, record, previous);
  }
  const nowMs = sandboxNowMs(loaded.sandbox.doc);
  let records = request.request_ids
    ? loaded.doc.requests.filter(record => request.request_ids!.includes(record.request_id))
    : loaded.doc.requests.filter(record => record.state === 'in_review'
      || record.state === 'ambiguous'
      || Date.parse(record.updated_at) >= nowMs - RECENT_WINDOW_MS);
  records = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.request_id.localeCompare(a.request_id));
  const max = Math.min(Math.max(request.requests_pagination?.max_results ?? 50, 1), 100);
  const cursor = request.requests_pagination?.cursor;
  const offset = cursor && /^areq_page_\d+$/.test(cursor) ? Number(cursor.slice('areq_page_'.length)) : 0;
  const page = records.slice(offset, offset + max);
  const hasMore = offset + page.length < records.length;
  return {
    account_requests: await Promise.all(page.map(record => wireRequest(ctx, record))),
    account_requests_pagination: {
      has_more: hasMore,
      total_count: records.length,
      ...(hasMore && { cursor: `areq_page_${offset + page.length}` }),
    },
  };
}

/**
 * Principal-level reporting subscriptions (experimental,
 * `media_buy.reporting_subscriptions`, AdCP 3.3) for the training agent.
 *
 * A subscription is registered once on the principal through the
 * sync_principal `reporting_subscriptions` section and follows the caller's
 * account authority. This module owns:
 *
 * - **Registration**: validation, versioning (each semantic change is a new
 *   `subscription_version` with its own `accepted_at`), deactivation and
 *   reactivation (`inactive_intervals`), and in-place membership edits.
 * - **Readback**: `reporting-subscription-state.json`, with `prior_versions`
 *   (and their configuration), the `*_count` totals, and paging.
 * - **Coverage**: the seller's exceptions for one account (`gaps`,
 *   `timezone_cutovers`, and `excluded` entries for capacity, membership
 *   edits, unsupported offerings, and precedence), and the periods owed. The
 *   owed periods come from the spec's reference model
 *   (`scripts/reference/reporting-coverage/`), fed with exactly what a buyer
 *   reads from the wire, so a buyer's computation and the seller's
 *   obligations agree by construction.
 *
 * Deliberate simplifications of this reference seller:
 * - It produces no report content for subscription obligations: they read
 *   `pending` and age into `delayed` / `action_required` on the sandbox clock.
 * - Account-timezone periods use the reference model's pinned tzdata subset.
 *   An account whose timezone the model does not carry (or with no timezone)
 *   gets no account-timezone offering.
 * - Precedence covers the caller's account-level configurations and its
 *   `account_ids` subscriptions over all-accounts ones; it does not split
 *   packages between two pacing or analytics subscriptions that resolve the
 *   same offering.
 */
import { createHash } from 'node:crypto';
import {
  coverageModelHasZone,
  expectedSubscriptionPeriods,
  resolvePackageWithModel,
  scheduleCalendar,
  type CoverageModelObligation,
} from './reporting-coverage-model.js';
import {
  TRAINING_REPORTING_ACCOUNT_TIMEZONE_OFFERING,
  TRAINING_REPORTING_CORE_OFFERING,
  TRAINING_REPORTING_MANAGED_OFFERING,
  TRAINING_REPORTING_RECONCILED_OFFERING,
} from './reporting-reliability.js';
import { STATUS_RETENTION_DAYS, type GrantRecord, type TimezoneChange } from './account-sandbox.js';

type Json = Record<string, unknown>;

export const REPORTING_SUBSCRIPTIONS_FEATURE = 'media_buy.reporting_subscriptions';
export const SUBSCRIPTION_MAX_ACCOUNTS = 3;
export const SUBSCRIPTION_BACKFILL_ON_REGRANT = false;
const MAX_SUBSCRIPTION_RECORDS = 64;
const INLINE_PRIOR_VERSIONS = 16;
const INLINE_ACCOUNTS = 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECOVERY_WINDOW_MS = 2 * HOUR_MS;

/** `media_buy.reporting_delivery.subscriptions` capability block. */
export const SUBSCRIPTIONS_CAPABILITY = {
  supported: true,
  max_accounts: SUBSCRIPTION_MAX_ACCOUNTS,
  backfill_on_regrant: SUBSCRIPTION_BACKFILL_ON_REGRANT,
} as const;

// ── Offerings ──────────────────────────────────────────────────────

type Offering = Json & {
  offering_id: string;
  feed_purpose: string;
  report_definition_id: string;
  reporting_profile: { id: string };
  schedule: { period_duration: string; alignment: string; delivery_sla: string; period_timezone?: string };
  supported_finality: string[];
  reconciliation_mode: string;
  method?: { pattern: string; transport: string };
  standard_dimensions: string[];
};

/** Every advertised offering, with its breakdown in the standard vocabulary.
 * The training agent's report definitions are one aggregate row per period,
 * so every offering is totals-only. */
export function subscriptionOfferings(): Offering[] {
  return [
    TRAINING_REPORTING_CORE_OFFERING,
    TRAINING_REPORTING_MANAGED_OFFERING,
    TRAINING_REPORTING_RECONCILED_OFFERING,
    TRAINING_REPORTING_ACCOUNT_TIMEZONE_OFFERING,
  ].map(offering => ({ ...structuredClone(offering), standard_dimensions: [] }) as unknown as Offering);
}

function offeringById(id: string): Offering | undefined {
  return subscriptionOfferings().find(offering => offering.offering_id === id);
}

function slaMs(duration: string): number {
  const match = /^PT(\d+)H$/.exec(duration);
  return match ? Number(match[1]) * HOUR_MS : 4 * HOUR_MS;
}

// ── Registration ───────────────────────────────────────────────────

export interface SubscriptionVersion {
  subscription_version: number;
  accepted_at: string;
  configuration: Json;
  superseded_at?: string;
}

export interface MembershipEvent {
  at: string;
  account_ids?: string[];
  exclude_account_ids?: string[];
}

export interface SubscriptionRecord extends Json {
  subscription_id: string;
  active: boolean;
  configuration: Json;
  versions: SubscriptionVersion[];
  inactive_intervals: Array<{ deactivated_at: string; reactivated_at?: string }>;
  membership: MembershipEvent[];
}

export class SubscriptionRejection extends Error {
  constructor(readonly code: string, message: string, readonly field = 'configuration.reporting_subscriptions') {
    super(message);
  }
}

function reject(message: string, code = 'INVALID_REQUEST'): never {
  throw new SubscriptionRejection(code, message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Json)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** What a new subscription_version is required for: selector,
 * reconciliation_mode, destination (with overrides), scope kind, and
 * operator_domains. Membership and the in-place flags are not semantic. */
function semanticKey(configuration: Json): string {
  const {
    active: _active,
    replace_account_configs: _replace,
    exclude_account_ids: _exclude,
    subscription_version: _version,
    scope,
    ...rest
  } = configuration;
  const kind = (scope as Json | undefined)?.all_authorized_accounts === true ? 'all_authorized_accounts' : 'account_ids';
  return canonicalJson({ ...rest, scope_kind: kind });
}

function membershipOf(configuration: Json): Omit<MembershipEvent, 'at'> {
  const scope = configuration.scope as Json;
  return {
    ...(Array.isArray(scope.account_ids) && { account_ids: [...(scope.account_ids as string[])].sort() }),
    ...(Array.isArray(configuration.exclude_account_ids) && {
      exclude_account_ids: [...(configuration.exclude_account_ids as string[])].sort(),
    }),
  };
}

function scopeCanCoverSeveral(configuration: Json): boolean {
  const scope = configuration.scope as Json;
  return scope.all_authorized_accounts === true || ((scope.account_ids as string[] | undefined)?.length ?? 0) > 1;
}

interface DestinationView {
  destination_id: string;
  destination_ref: string;
  pattern: string;
  transport: string;
}

/**
 * Validate a complete desired subscription set against the request's
 * resulting reporting destinations. Throws SubscriptionRejection.
 */
export function validateSubscriptions(
  desired: Json[],
  destinations: DestinationView[],
  callerDeliveryConfigIds: Set<string>,
): void {
  const seen = new Set<string>();
  const byId = new Map(destinations.map(destination => [destination.destination_id, destination]));
  for (const subscription of desired) {
    const id = String(subscription.subscription_id);
    if (seen.has(id)) reject(`duplicate subscription_id: ${id}`);
    seen.add(id);
    if (callerDeliveryConfigIds.has(id)) {
      reject(`subscription_id ${id} collides with a delivery_config_id you use on an account`);
    }
    const destination = subscription.destination as Json | undefined;
    if (destination) {
      const target = byId.get(String(destination.destination_id));
      if (!target) reject(`destination_id ${String(destination.destination_id)} is not one of your reporting_destinations`);
      const template = destination.path_template as string | undefined;
      if (target!.pattern === 'file_transfer' && scopeCanCoverSeveral(subscription)
        && !(template && template.includes('{account_id}'))) {
        reject(`subscription ${id} can cover several accounts, so its file_transfer path_template must contain {account_id}`);
      }
      const overrides = (subscription.destination_overrides as Json[] | undefined) ?? [];
      const overrideAccounts = new Set<string>();
      const overrideDomains = new Set<string>();
      for (const override of overrides) {
        const overrideTarget = byId.get(String(override.destination_id));
        if (!overrideTarget) reject(`destination_overrides destination_id ${String(override.destination_id)} is not one of your reporting_destinations`);
        if (overrideTarget!.pattern !== target!.pattern || overrideTarget!.transport !== target!.transport) {
          reject(`destination_overrides destination ${String(override.destination_id)} must have the pattern and transport of ${target!.destination_id}`);
        }
        for (const accountId of (override.account_ids as string[] | undefined) ?? []) {
          if (overrideAccounts.has(accountId)) reject(`account ${accountId} appears in two destination_overrides entries`);
          overrideAccounts.add(accountId);
        }
        for (const domain of (override.operator_domains as string[] | undefined) ?? []) {
          if (overrideDomains.has(domain)) reject(`operator domain ${domain} appears in two destination_overrides entries`);
          overrideDomains.add(domain);
        }
      }
    } else if (subscription.destination_overrides !== undefined) {
      reject(`subscription ${id} has destination_overrides without a destination`);
    }
  }
  const active = desired.filter(subscription => subscription.active !== false);
  // Active subscriptions that share a destination need distinct
  // account-qualified templates, so their deliveries never collide.
  const byDestination = new Map<string, Json[]>();
  for (const subscription of active) {
    const destination = subscription.destination as Json | undefined;
    if (!destination) continue;
    const list = byDestination.get(String(destination.destination_id)) ?? [];
    list.push(subscription);
    byDestination.set(String(destination.destination_id), list);
  }
  for (const [destinationId, list] of byDestination) {
    if (list.length < 2) continue;
    const templates = list.map(subscription => (subscription.destination as Json).path_template as string | undefined);
    if (templates.some(template => !template?.includes('{account_id}')) || new Set(templates).size !== templates.length) {
      reject(`active subscriptions sharing destination ${destinationId} need distinct path_templates containing {account_id}`);
    }
  }
  // Billing: one active subscription per account at a scope level.
  const billing = active.filter(subscription => (subscription.selector as Json).feed_purpose === 'billing');
  const allAccounts = billing.filter(subscription => (subscription.scope as Json).all_authorized_accounts === true);
  for (let i = 0; i < allAccounts.length; i += 1) {
    for (let j = i + 1; j < allAccounts.length; j += 1) {
      const a = allAccounts[i]!.operator_domains as string[] | undefined;
      const b = allAccounts[j]!.operator_domains as string[] | undefined;
      if (!a || !b || a.some(domain => b.includes(domain))) {
        reject('two active all-accounts billing subscriptions would both apply to one account');
      }
    }
  }
  const named = new Map<string, string>();
  for (const subscription of billing) {
    for (const accountId of ((subscription.scope as Json).account_ids as string[] | undefined) ?? []) {
      if (named.has(accountId)) reject(`two active billing subscriptions name account ${accountId}`);
      named.set(accountId, String(subscription.subscription_id));
    }
  }
}

/**
 * Apply a complete desired set to the prior records at `nowIso`. Omitted
 * subscriptions are deactivated and stay readable. Throws on a reused
 * version with different semantics or a version that goes backwards.
 */
export function applySubscriptions(prior: SubscriptionRecord[], desired: Json[], nowIso: string): SubscriptionRecord[] {
  const next = new Map(prior.map(record => [record.subscription_id, structuredClone(record)]));
  const desiredIds = new Set<string>();
  for (const configuration of desired) {
    const id = String(configuration.subscription_id);
    desiredIds.add(id);
    const version = Number(configuration.subscription_version);
    const active = configuration.active !== false;
    const existing = next.get(id);
    if (!existing) {
      next.set(id, {
        subscription_id: id,
        active,
        configuration: structuredClone(configuration),
        versions: [{ subscription_version: version, accepted_at: nowIso, configuration: structuredClone(configuration) }],
        inactive_intervals: active ? [] : [{ deactivated_at: nowIso }],
        membership: [{ at: nowIso, ...membershipOf(configuration) }],
      });
      continue;
    }
    const current = existing.versions[existing.versions.length - 1]!;
    if (version < current.subscription_version) {
      reject(`subscription ${id}: subscription_version ${version} is older than the current version ${current.subscription_version}`);
    }
    if (version === current.subscription_version && semanticKey(configuration) !== semanticKey(current.configuration)) {
      reject(`subscription ${id}: subscription_version ${version} is reused with different delivery semantics; send a new version`);
    }
    if (version > current.subscription_version) {
      current.superseded_at = nowIso;
      existing.versions.push({ subscription_version: version, accepted_at: nowIso, configuration: structuredClone(configuration) });
      existing.membership.push({ at: nowIso, ...membershipOf(configuration) });
    } else if (canonicalJson(membershipOf(configuration)) !== canonicalJson(membershipOf(existing.configuration))) {
      existing.membership.push({ at: nowIso, ...membershipOf(configuration) });
    }
    if (existing.active && !active) existing.inactive_intervals.push({ deactivated_at: nowIso });
    if (!existing.active && active) {
      const open = existing.inactive_intervals[existing.inactive_intervals.length - 1];
      if (open && open.reactivated_at === undefined) open.reactivated_at = nowIso;
    }
    existing.active = active;
    existing.configuration = structuredClone(configuration);
  }
  for (const record of next.values()) {
    if (desiredIds.has(record.subscription_id) || !record.active) continue;
    record.active = false;
    record.configuration = { ...record.configuration, active: false };
    record.inactive_intervals.push({ deactivated_at: nowIso });
  }
  const records = [...next.values()];
  if (records.length <= MAX_SUBSCRIPTION_RECORDS) return records;
  // Keep every active record and the most recent inactive ones.
  const active = records.filter(record => record.active);
  const inactive = records.filter(record => !record.active)
    .slice(-Math.max(0, MAX_SUBSCRIPTION_RECORDS - active.length));
  return [...active, ...inactive];
}

/** Whether a change to the section changed anything observable. */
export function subscriptionsChanged(prior: SubscriptionRecord[], next: SubscriptionRecord[]): boolean {
  const view = (records: SubscriptionRecord[]) => canonicalJson(records.map(record => ({
    id: record.subscription_id,
    active: record.active,
    configuration: record.configuration,
    versions: record.versions.map(version => version.subscription_version),
  })));
  return view(prior) !== view(next);
}

// ── Coverage ───────────────────────────────────────────────────────

export interface CoverageAccount {
  account_id: string;
  operator: string;
  /** Current timezone as list_accounts shows it. */
  timezone?: string;
  /** Opening attribute order for admission ties. */
  grant: GrantRecord | undefined;
  timezone_changes: TimezoneChange[];
}

export interface CoverageBuy {
  media_buy_id: string;
  confirmed_at: string | null;
  start_time: string;
  end_time: string;
  canceled_at?: string;
  completed_at?: string;
  packages: Array<{ package_id: string; reporting_delivery_offering_ids: string[] }>;
}

export interface CoverageContext {
  nowMs: number;
  subscriptions: SubscriptionRecord[];
  destinations: DestinationView[];
  /** Every account the caller holds, for admission. */
  accounts: CoverageAccount[];
  /** The caller's active account-level configurations, per account. */
  accountConfigs: (accountId: string) => Array<{ delivery_config_id: string; feed_purpose: string; activated_at: string }>;
}

export interface SubscriptionAccountCoverage {
  subscription_id: string;
  /** The wire `subscription_coverage[]` entry, absent when the subscription has nothing for the account. */
  entry?: Json;
  obligations: CoverageModelObligation[];
  /** Offerings the subscription resolves for this account's buys. */
  offerings: Offering[];
  /** Open exception reasons (accounts_with_exceptions). */
  open_reasons: string[];
  /** Present while the caller's authority over a covered account is lost. */
  unauthorized?: { unauthorized_at: string; last_owed_period_end?: string; withheld_period_count: number };
  current_version: number;
  feed_purpose: string;
  required_finality: string;
  reconciliation_mode: string;
  /** Grant interruptions continued by a re-grant, for withheld-period deadlines. */
  regrants: Array<{ unauthorized_at: string; regranted_at: string }>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function inScopeOf(configuration: Json, membership: Omit<MembershipEvent, 'at'>, account: CoverageAccount): boolean {
  const scope = configuration.scope as Json;
  const selected = scope.all_authorized_accounts === true
    ? !(membership.exclude_account_ids ?? []).includes(account.account_id)
    : (membership.account_ids ?? []).includes(account.account_id);
  if (!selected) return false;
  const domains = configuration.operator_domains as string[] | undefined;
  return domains === undefined || domains.includes(account.operator);
}

/** Membership snapshot in effect at `atMs` (the latest event at or before it). */
function membershipAt(record: SubscriptionRecord, atMs: number): Omit<MembershipEvent, 'at'> | undefined {
  let current: MembershipEvent | undefined;
  for (const event of record.membership) {
    if (Date.parse(event.at) <= atMs) current = event;
  }
  return current;
}

function versionAt(record: SubscriptionRecord, atMs: number): SubscriptionVersion | undefined {
  return record.versions.find(version => Date.parse(version.accepted_at) <= atMs
    && (version.superseded_at === undefined || atMs < Date.parse(version.superseded_at)));
}

function everInScope(record: SubscriptionRecord, account: CoverageAccount): boolean {
  return record.membership.some(event => {
    const version = versionAt(record, Date.parse(event.at)) ?? record.versions[record.versions.length - 1]!;
    return inScopeOf(version.configuration, event, account);
  });
}

/** Whether any of the caller's subscriptions has ever covered the account. */
export function accountEverInScope(subscriptions: SubscriptionRecord[], account: CoverageAccount): boolean {
  return subscriptions.some(record => everInScope(record, account));
}

/** Authorization intervals for coverage: the grant history, in the model's shape. */
function grantIntervals(grant: GrantRecord | undefined): Array<{ authorized_at: string; unauthorized_at?: string }> {
  if (!grant) return [];
  return grant.history.map(interval => ({
    authorized_at: interval.authorized_at,
    ...(interval.unauthorized_at && { unauthorized_at: interval.unauthorized_at }),
  }));
}

function authorizedAt(account: CoverageAccount, atMs: number): boolean {
  return grantIntervals(account.grant).some(interval => Date.parse(interval.authorized_at) <= atMs
    && (interval.unauthorized_at === undefined || atMs < Date.parse(interval.unauthorized_at)));
}

/** Zone in effect for account-timezone periods starting at `atMs`, from the
 * recorded changes (each effective from its cutover instant). */
function zoneAt(account: CoverageAccount, cutovers: Array<{ effective_at: string; previous_timezone: string; timezone: string }>, atMs: number): string | undefined {
  if (cutovers.length === 0) return account.timezone;
  let zone = cutovers[0]!.previous_timezone;
  for (const cutover of cutovers) if (Date.parse(cutover.effective_at) <= atMs) zone = cutover.timezone;
  return zone;
}

function calendarFor(offering: Offering, zone: string | undefined) {
  const { schedule } = offering;
  if (schedule.alignment === 'utc') return scheduleCalendar(schedule.period_duration, 'utc');
  if (schedule.alignment === 'source_timezone') return scheduleCalendar(schedule.period_duration, 'local', schedule.period_timezone);
  return scheduleCalendar(schedule.period_duration, 'local', zone ?? 'UTC');
}

function boundariesAround(offering: Offering, zone: string | undefined, atMs: number): { atOrBefore: number; atOrAfter: number } {
  const calendar = calendarFor(offering, zone);
  const periods = calendar.periods(atMs - 40 * DAY_MS, atMs + 40 * DAY_MS);
  let atOrBefore = Number.NEGATIVE_INFINITY;
  let atOrAfter = Number.POSITIVE_INFINITY;
  for (const period of periods) {
    if (period.start <= atMs && period.start > atOrBefore) atOrBefore = period.start;
    if (period.start >= atMs && period.start < atOrAfter) atOrAfter = period.start;
  }
  return { atOrBefore, atOrAfter };
}

/** Group per-offering instants into entries: one without offering_id when
 * every offering shares them, otherwise one per offering. */
function perOffering<T extends Json>(
  offerings: Offering[],
  build: (offering: Offering) => T | undefined,
): Array<T & { offering_id?: string }> {
  const built = offerings.map(offering => ({ offering, entry: build(offering) }))
    .filter((item): item is { offering: Offering; entry: T } => item.entry !== undefined);
  if (built.length === 0) return [];
  const keys = new Set(built.map(item => canonicalJson(item.entry)));
  if (keys.size === 1) return [built[0]!.entry];
  return built.map(item => ({ offering_id: item.offering.offering_id, ...item.entry }));
}

/**
 * Exception entries whose instants are cutover boundaries: per resolved
 * offering (grouped by perOffering), or the raw instants when the account
 * resolves no offering yet.
 */
function exceptionEntries(
  resolved: Offering[],
  zoneFor: (atMs: number) => string | undefined,
  build: (boundary: (atMs: number) => string) => Json,
): Json[] {
  if (resolved.length === 0) return [build(iso)];
  return perOffering(resolved, offering => build(atMs => iso(boundariesAround(offering, zoneFor(atMs), atMs).atOrAfter)));
}

function destinationMethod(configuration: Json, destinations: DestinationView[]): { pattern: string; transport: string } | undefined {
  const destination = configuration.destination as Json | undefined;
  if (!destination) return undefined;
  const target = destinations.find(candidate => candidate.destination_id === destination.destination_id);
  return target ? { pattern: target.pattern, transport: target.transport } : undefined;
}

/**
 * Offerings each package of each buy resolves under a version, using the
 * reference model's selection rule.
 */
function resolveOfferings(
  version: SubscriptionVersion,
  buys: CoverageBuy[],
  offerings: Offering[],
  destinations: DestinationView[],
): Map<string, { resolved: Set<string>; unresolvedPackages: string[] }> {
  const byId = new Map(offerings.map(offering => [offering.offering_id, offering]));
  const normalized = { config: version.configuration, destinationMethod: destinationMethod(version.configuration, destinations) };
  const out = new Map<string, { resolved: Set<string>; unresolvedPackages: string[] }>();
  for (const buy of buys) {
    if (!buy.confirmed_at) continue;
    // A package resolves once, when its (buy, version) pair first meets.
    const at = Math.max(Date.parse(version.accepted_at), Date.parse(buy.confirmed_at));
    const resolved = new Set<string>();
    const unresolvedPackages: string[] = [];
    for (const pkg of buy.packages) {
      const ids = resolvePackageWithModel(pkg, normalized, byId, at);
      if (ids.length === 0) unresolvedPackages.push(pkg.package_id);
      for (const id of ids) resolved.add(id);
    }
    out.set(buy.media_buy_id, { resolved, unresolvedPackages });
  }
  return out;
}

/** The offerings a version's selector resolves among everything advertised. */
function selectorOfferings(version: SubscriptionVersion, offerings: Offering[], destinations: DestinationView[]): Offering[] {
  const byId = new Map(offerings.map(offering => [offering.offering_id, offering]));
  const ids = resolvePackageWithModel(
    { package_id: 'selector', reporting_delivery_offering_ids: offerings.map(offering => offering.offering_id) },
    { config: version.configuration, destinationMethod: destinationMethod(version.configuration, destinations) },
    byId,
    Date.parse(version.accepted_at),
  );
  return offerings.filter(offering => ids.includes(offering.offering_id));
}

/** Admission under max_accounts: sticky, ordered by authorized_at then account_id. */
function capacityWaits(
  record: SubscriptionRecord,
  accounts: CoverageAccount[],
  nowMs: number,
): Map<string, Array<{ from: number; until?: number }>> {
  const events = new Set<number>();
  for (const version of record.versions) events.add(Date.parse(version.accepted_at));
  for (const event of record.membership) events.add(Date.parse(event.at));
  for (const interval of record.inactive_intervals) {
    events.add(Date.parse(interval.deactivated_at));
    if (interval.reactivated_at) events.add(Date.parse(interval.reactivated_at));
  }
  for (const account of accounts) {
    for (const interval of grantIntervals(account.grant)) {
      events.add(Date.parse(interval.authorized_at));
      if (interval.unauthorized_at) events.add(Date.parse(interval.unauthorized_at));
    }
  }
  const ordered = [...events].filter(t => t <= nowMs).sort((a, b) => a - b);
  const admitted = new Set<string>();
  const waits = new Map<string, Array<{ from: number; until?: number }>>();
  const inactiveAt = (t: number) => record.inactive_intervals.some(interval => Date.parse(interval.deactivated_at) <= t
    && (interval.reactivated_at === undefined || t < Date.parse(interval.reactivated_at)));
  for (const t of ordered) {
    const version = versionAt(record, t);
    const membership = membershipAt(record, t);
    const candidates = version && membership && !inactiveAt(t)
      ? accounts.filter(account => inScopeOf(version.configuration, membership, account) && authorizedAt(account, t))
      : [];
    const candidateIds = new Set(candidates.map(account => account.account_id));
    for (const id of [...admitted]) if (!candidateIds.has(id)) admitted.delete(id);
    const sorted = [...candidates].sort((a, b) => {
      const at = Date.parse(a.grant?.authorized_at ?? '') - Date.parse(b.grant?.authorized_at ?? '');
      return at !== 0 ? at : Buffer.compare(Buffer.from(a.account_id), Buffer.from(b.account_id));
    });
    for (const account of sorted) {
      if (admitted.size >= SUBSCRIPTION_MAX_ACCOUNTS) break;
      admitted.add(account.account_id);
    }
    for (const account of accounts) {
      const list = waits.get(account.account_id) ?? [];
      const open = list.length > 0 && list[list.length - 1]!.until === undefined ? list[list.length - 1] : undefined;
      const waiting = candidateIds.has(account.account_id) && !admitted.has(account.account_id);
      if (waiting && !open) list.push({ from: t });
      if (!waiting && open) open.until = t;
      if (list.length > 0) waits.set(account.account_id, list);
    }
  }
  return waits;
}

/** Membership edits for one account: excluded_by_buyer windows. */
function membershipWindows(record: SubscriptionRecord, account: CoverageAccount): Array<{ from: number; until?: number; joined?: boolean }> {
  const windows: Array<{ from: number; until?: number; joined?: boolean }> = [];
  let previousIn: boolean | undefined;
  for (const event of record.membership) {
    const atMs = Date.parse(event.at);
    const version = versionAt(record, atMs) ?? record.versions[record.versions.length - 1]!;
    const isNewVersion = record.versions.some(candidate => candidate.accepted_at === event.at);
    const inNow = inScopeOf(version.configuration, event, account);
    if (isNewVersion) {
      // A new version starts membership afresh: the ordinary start rule applies.
      const open = windows[windows.length - 1];
      if (open && open.until === undefined) open.until = atMs;
      previousIn = inNow;
      continue;
    }
    if (previousIn === true && !inNow) windows.push({ from: atMs });
    if (previousIn === false && inNow) {
      const open = windows[windows.length - 1];
      if (open && open.until === undefined) open.until = atMs;
      else windows.push({ from: Date.parse(version.accepted_at), until: atMs, joined: true });
    }
    previousIn = inNow;
  }
  return windows;
}

/**
 * Coverage of one account by each of the caller's subscriptions whose scope
 * has ever included it.
 */
export function coverageForAccount(
  context: CoverageContext,
  account: CoverageAccount,
  buys: CoverageBuy[],
): SubscriptionAccountCoverage[] {
  const out: SubscriptionAccountCoverage[] = [];
  const nowMs = context.nowMs;
  const tzSupported = account.timezone !== undefined
    && coverageModelHasZone(account.timezone)
    && account.timezone_changes.every(change => coverageModelHasZone(change.previous_timezone) && coverageModelHasZone(change.timezone));
  const offerings = subscriptionOfferings()
    .filter(offering => offering.schedule.alignment !== 'account_timezone' || tzSupported);
  const confirmedBuys = buys.filter(buy => buy.confirmed_at);

  for (const record of context.subscriptions) {
    if (!everInScope(record, account)) continue;
    const current = record.versions[record.versions.length - 1]!;
    const selector = current.configuration.selector as Json;
    // Offerings any version resolves for any of the account's buys.
    const resolvedIds = new Set<string>();
    const resolvedByVersion = new Map<number, Set<string>>();
    const unsupported: Json[] = [];
    for (const version of record.versions) {
      const resolution = resolveOfferings(version, confirmedBuys, offerings, context.destinations);
      const versionIds = new Set<string>();
      resolvedByVersion.set(version.subscription_version, versionIds);
      for (const [mediaBuyId, result] of resolution) {
        for (const id of result.resolved) {
          resolvedIds.add(id);
          versionIds.add(id);
        }
        if (version === current && result.unresolvedPackages.length > 0) {
          const buy = confirmedBuys.find(candidate => candidate.media_buy_id === mediaBuyId)!;
          const from = iso(Math.max(Date.parse(version.accepted_at), Date.parse(buy.confirmed_at!)));
          unsupported.push({
            media_buy_id: mediaBuyId,
            reason: 'offering_unsupported',
            from,
            ...(result.resolved.size > 0 && { package_ids: result.unresolvedPackages }),
          });
        }
      }
    }
    const resolved = offerings.filter(offering => resolvedIds.has(offering.offering_id));
    // Exception instants use the offerings of the version in effect then;
    // before the account has a buy, the offerings its selector would resolve.
    const offeringsAt = (atMs: number): Offering[] => {
      const version = versionAt(record, atMs) ?? current;
      const ids = resolvedByVersion.get(version.subscription_version) ?? new Set<string>();
      const fromBuys = offerings.filter(offering => ids.has(offering.offering_id));
      return fromBuys.length > 0 ? fromBuys : selectorOfferings(version, offerings, context.destinations);
    };

    // Timezone cutovers for account-timezone offerings: E is the end of the
    // last old-timezone period that started before the change.
    const cutovers: Array<{ offering_id?: string; previous_timezone: string; effective_at: string; timezone: string }> = [];
    for (const change of account.timezone_changes) {
      const atMs = Date.parse(change.at);
      const tzOfferings = offeringsAt(atMs).filter(offering => offering.schedule.alignment === 'account_timezone');
      cutovers.push(...perOffering(tzOfferings, offering => {
        const { atOrAfter } = boundariesAround(offering, change.previous_timezone, atMs);
        return { previous_timezone: change.previous_timezone, effective_at: iso(atOrAfter), timezone: change.timezone };
      }));
    }
    const sortedCutovers = cutovers
      .map(cutover => ({ ...cutover }))
      .sort((a, b) => a.effective_at.localeCompare(b.effective_at));
    const zoneFor = (atMs: number) => zoneAt(account, sortedCutovers, atMs);

    const excluded: Json[] = [...unsupported];
    // Membership edits.
    for (const window of membershipWindows(record, account)) {
      excluded.push(...exceptionEntries(offeringsAt(window.from), zoneFor, boundary => ({
        reason: 'excluded_by_buyer',
        from: boundary(window.from),
        ...(window.until !== undefined && { until: boundary(window.until) }),
      })));
    }
    // Capacity: a waiting account's exception opens when it starts waiting
    // and ends at the first boundary at or after its admission.
    for (const wait of capacityWaits(record, context.accounts, nowMs).get(account.account_id) ?? []) {
      excluded.push(...exceptionEntries(offeringsAt(wait.from), zoneFor, boundary => ({
        reason: 'capacity',
        from: iso(wait.from),
        ...(wait.until !== undefined && { until: boundary(wait.until) }),
      })));
    }
    // Precedence: the caller's own account-level configuration for the same
    // feed purpose, then its account_ids subscription over an all-accounts one.
    const purpose = String(selector.feed_purpose);
    const scope = current.configuration.scope as Json;
    const overriding = context.accountConfigs(account.account_id).find(config => config.feed_purpose === purpose);
    const overridingSubscription = scope.all_authorized_accounts === true
      ? context.subscriptions.find(other => other !== record && other.active
        && ((other.configuration.scope as Json).account_ids as string[] | undefined)?.includes(account.account_id)
        && (other.configuration.selector as Json).feed_purpose === purpose)
      : undefined;
    if (overriding || overridingSubscription) {
      const startMs = Math.max(
        Date.parse(current.accepted_at),
        overriding
          ? Date.parse(overriding.activated_at)
          : Date.parse(overridingSubscription!.versions[overridingSubscription!.versions.length - 1]!.accepted_at),
      );
      const overriddenBy = overriding
        ? { delivery_config_id: overriding.delivery_config_id }
        : { subscription_id: overridingSubscription!.subscription_id };
      excluded.push(...exceptionEntries(offeringsAt(startMs), zoneFor, boundary => ({
        reason: 'overridden',
        from: boundary(startMs),
        overridden_by: overriddenBy,
      })));
    }

    // Unbackfilled gaps between a loss of authority and a re-grant that
    // continued the chain.
    const intervals = grantIntervals(account.grant);
    const regrants: Array<{ unauthorized_at: string; regranted_at: string }> = [];
    const gaps: Json[] = [];
    for (let index = 1; index < intervals.length; index += 1) {
      const lost = intervals[index - 1]!.unauthorized_at;
      const back = intervals[index]!.authorized_at;
      if (!lost) continue;
      const lostMs = Date.parse(lost);
      const backMs = Date.parse(back);
      if (backMs >= lostMs + STATUS_RETENTION_DAYS * DAY_MS) continue;
      regrants.push({ unauthorized_at: lost, regranted_at: back });
      if (SUBSCRIPTION_BACKFILL_ON_REGRANT) continue;
      gaps.push(...perOffering(offeringsAt(lostMs), offering => ({
        from: iso(boundariesAround(offering, zoneFor(lostMs), lostMs).atOrBefore),
        until: iso(boundariesAround(offering, zoneFor(backMs), backMs).atOrAfter),
        reason: 'unauthorized',
      })));
    }

    const coverageInput: Json = {
      excluded,
      gaps,
      timezone_cutovers: sortedCutovers,
    };
    // The owed periods, from the reference model, on exactly the wire inputs.
    let obligations: CoverageModelObligation[] = [];
    const authorized = intervals.length > 0;
    if (authorized && confirmedBuys.length > 0 && resolved.length > 0) {
      const lastInactive = record.inactive_intervals[record.inactive_intervals.length - 1];
      const versions = record.versions.map((version, index) => ({
        subscription_version: version.subscription_version,
        accepted_at: version.accepted_at,
        ...(version.superseded_at && { superseded_at: version.superseded_at }),
        ...(index === record.versions.length - 1 && !record.active && lastInactive && lastInactive.reactivated_at === undefined
          && { deactivated_at: lastInactive.deactivated_at }),
        configuration: withAccountInScope(version.configuration, account),
        ...(destinationMethod(version.configuration, context.destinations) && {
          destination_method: destinationMethod(version.configuration, context.destinations),
        }),
      }));
      const result = expectedSubscriptionPeriods({
        subscription_id: record.subscription_id,
        versions,
        inactive_intervals: record.inactive_intervals.filter(interval => interval.reactivated_at !== undefined),
        account: {
          account_id: account.account_id,
          operator: account.operator,
          ...(account.timezone && { timezone: account.timezone }),
          grants: intervals,
        },
        buys: confirmedBuys.map(buy => ({
          media_buy_id: buy.media_buy_id,
          confirmed_at: buy.confirmed_at,
          start_time: buy.start_time,
          end_time: buy.end_time,
          ...(buy.canceled_at && { canceled_at: buy.canceled_at, cancellation_effective_at: buy.canceled_at }),
          ...(buy.completed_at && { completed_at: buy.completed_at }),
          packages: buy.packages,
        })),
        offerings,
        coverage: coverageInput,
        status_retention_days: STATUS_RETENTION_DAYS,
        backfill_on_regrant: SUBSCRIPTION_BACKFILL_ON_REGRANT,
        now: iso(nowMs),
      });
      obligations = result.expected_obligations;
    }

    // Lost authority.
    let unauthorized: SubscriptionAccountCoverage['unauthorized'];
    const lostAt = account.grant?.unauthorized_at;
    if (lostAt) {
      const lostMs = Date.parse(lostAt);
      const owedBefore = obligations.filter(obligation => Date.parse(obligation.period_end) <= lostMs);
      const last = owedBefore.map(obligation => obligation.period_end).sort().at(-1);
      unauthorized = {
        unauthorized_at: lostAt,
        ...(last && { last_owed_period_end: last }),
        withheld_period_count: owedBefore.length,
      };
    }

    const lastInactive = record.inactive_intervals[record.inactive_intervals.length - 1];
    const accountLevelOpen = excluded.filter(entry => entry.media_buy_id === undefined && entry.until === undefined);
    const status = !record.active
      ? 'inactive'
      : accountLevelOpen.some(entry => entry.reason === 'action_required')
        ? 'action_required'
        : accountLevelOpen.length > 0 ? 'excluded' : 'active';
    const currentlyInScope = (() => {
      const membership = membershipAt(record, nowMs);
      return membership !== undefined && inScopeOf(current.configuration, membership, account);
    })();
    // A deactivated subscription is listed while it still has obligations;
    // one the account left in place while its excluded_by_buyer entry stays.
    const listed = record.active
      ? currentlyInScope || excluded.some(entry => entry.reason === 'excluded_by_buyer')
      : obligations.length > 0;
    const entry: Json | undefined = listed ? {
      subscription_id: record.subscription_id,
      subscription_version: current.subscription_version,
      status,
      ...(status === 'inactive' && lastInactive && { deactivated_at: lastInactive.deactivated_at }),
      excluded,
      ...(sortedCutovers.length > 0 && { timezone_cutovers: sortedCutovers }),
      ...(gaps.length > 0 && { gaps }),
    } : undefined;
    out.push({
      subscription_id: record.subscription_id,
      ...(entry && { entry }),
      obligations,
      offerings: resolved,
      open_reasons: [...new Set(excluded.filter(item => item.until === undefined).map(item => String(item.reason)))],
      ...(unauthorized && { unauthorized }),
      current_version: current.subscription_version,
      feed_purpose: purpose,
      required_finality: String(selector.required_finality),
      reconciliation_mode: String(current.configuration.reconciliation_mode),
      regrants,
    });
  }
  return out;
}

/** The version's configuration with this account kept in scope: membership
 * edits are applied as excluded_by_buyer exceptions, not as scope changes. */
function withAccountInScope(configuration: Json, account: CoverageAccount): Json {
  const scope = configuration.scope as Json;
  const next = structuredClone(configuration);
  if (Array.isArray(scope.account_ids)) {
    const ids = new Set(scope.account_ids as string[]);
    ids.add(account.account_id);
    next.scope = { account_ids: [...ids].sort() };
  }
  if (Array.isArray(next.exclude_account_ids)) {
    const remaining = (next.exclude_account_ids as string[]).filter(id => id !== account.account_id);
    if (remaining.length > 0) next.exclude_account_ids = remaining;
    else delete next.exclude_account_ids;
  }
  return next;
}

// ── Obligations on get_reporting_status ────────────────────────────

function stableId(kind: string, values: readonly string[]): string {
  return `${kind}.${createHash('sha256').update(values.join('\u001f')).digest('hex').slice(0, 24)}`;
}

function healthFor(expectedAtMs: number, nowMs: number): 'waiting' | 'delayed' | 'action_required' {
  if (nowMs < expectedAtMs) return 'waiting';
  return nowMs < expectedAtMs + RECOVERY_WINDOW_MS ? 'delayed' : 'action_required';
}

/** Ledger obligations for one subscription's owed periods on one account. */
export function subscriptionObligationRecords(
  accountId: string,
  coverage: SubscriptionAccountCoverage,
  account: CoverageAccount,
  nowMs: number,
): Json[] {
  const byId = new Map(coverage.offerings.map(offering => [offering.offering_id, offering]));
  const cutovers = (coverage.entry?.timezone_cutovers as Array<{ effective_at: string; previous_timezone: string; timezone: string }> | undefined) ?? [];
  return coverage.obligations.map(obligation => {
    const offering = byId.get(obligation.offering_id) ?? offeringById(obligation.offering_id)!;
    const periodEndMs = Date.parse(obligation.period_end);
    const sla = slaMs(offering.schedule.delivery_sla);
    // This seller delivers no report content, so every owed period that ended
    // by a loss of authority was withheld; after a re-grant that continued the
    // chain it is due at the re-grant plus the offering's SLA.
    const regrant = coverage.regrants.find(item => periodEndMs <= Date.parse(item.unauthorized_at));
    const expectedAtMs = regrant ? Date.parse(regrant.regranted_at) + sla : periodEndMs + sla;
    const health = healthFor(expectedAtMs, nowMs);
    const id = stableId('reporting-obligation', [
      accountId, coverage.subscription_id, String(obligation.subscription_version), obligation.offering_id, obligation.period_end,
    ]);
    const sourceTimezone = offering.schedule.alignment === 'account_timezone'
      ? zoneAt(account, cutovers, Date.parse(obligation.period_start)) ?? 'UTC'
      : offering.schedule.period_timezone ?? 'UTC';
    const issues = health === 'waiting' ? [] : [{
      issue_id: stableId('reporting-issue', [id, health]),
      code: 'REPORT_OVERDUE',
      severity: health,
      responsible_party: 'seller',
      recommended_action: health === 'delayed' ? 'wait_for_retry' : 'contact_seller',
      reporting_obligation_id: id,
      delivery_config_id: coverage.subscription_id,
      delivery_config_version: obligation.subscription_version,
      feed_purpose: offering.feed_purpose,
      media_buy_ids: obligation.media_buy_ids,
      period_start: obligation.period_start,
      period_end: obligation.period_end,
      expected_at: iso(expectedAtMs),
    }];
    return {
      reporting_obligation_id: id,
      delivery_config_id: coverage.subscription_id,
      delivery_config_version: obligation.subscription_version,
      report_definition_id: offering.report_definition_id,
      offering_id: obligation.offering_id,
      feed_purpose: offering.feed_purpose,
      ...(obligation.stub && { stub: true }),
      reporting_profile: offering.reporting_profile.id,
      account_id: accountId,
      media_buy_ids: obligation.media_buy_ids,
      scope_resolved_at: obligation.period_end,
      coverage: {
        status: 'full',
        evaluated_at: obligation.period_end,
        media_buy_ids: obligation.media_buy_ids,
        fully_covered_media_buy_ids: obligation.media_buy_ids,
        partially_covered_media_buy_ids: [],
        unsupported_media_buy_ids: [],
        unknown_media_buy_ids: [],
        package_ids: [],
        covered_package_ids: [],
        unsupported_package_ids: [],
        unknown_package_ids: [],
        limitations: [],
      },
      period: { start: obligation.period_start, end: obligation.period_end, source_timezone: sourceTimezone },
      expected_at: iso(expectedAtMs),
      schedule: structuredClone(offering.schedule),
      required_finality: coverage.required_finality,
      reconciliation_mode: coverage.reconciliation_mode,
      reconciliation_status: coverage.reconciliation_mode === 'consumer_receipt' ? 'pending' : 'not_required',
      health,
      production_status: 'pending',
      revision_count: 0,
      adjustment_count: 0,
      issues,
    };
  });
}

// ── Readback ───────────────────────────────────────────────────────

export interface SubscriptionReadbackExtras {
  accounts_with_exceptions: Array<{ account_id: string; reasons: string[] }>;
  accounts_unauthorized: Array<{ account_id: string; unauthorized_at: string; last_owed_period_end?: string; withheld_period_count: number }>;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** reporting-subscription-state.json for one record. */
export function subscriptionState(
  record: SubscriptionRecord,
  destinations: DestinationView[],
  extras: SubscriptionReadbackExtras,
): Json {
  const current = record.versions[record.versions.length - 1]!;
  const prior = record.versions.slice(0, -1).reverse();
  const lastInactive = record.inactive_intervals[record.inactive_intervals.length - 1];
  const destination = record.configuration.destination as Json | undefined;
  const destinationRef = destination
    ? destinations.find(candidate => candidate.destination_id === destination.destination_id)?.destination_ref
    : undefined;
  const overrides = (record.configuration.destination_overrides as Json[] | undefined) ?? [];
  const withExceptions = [...extras.accounts_with_exceptions].sort((a, b) => byteOrder(a.account_id, b.account_id));
  const unauthorized = [...extras.accounts_unauthorized].sort((a, b) => byteOrder(a.account_id, b.account_id));
  return {
    subscription_id: record.subscription_id,
    subscription_version: current.subscription_version,
    state: record.active ? 'active' : 'inactive',
    accepted_at: current.accepted_at,
    ...(prior.length > 0 && {
      prior_versions: prior.slice(0, INLINE_PRIOR_VERSIONS).map(priorVersion),
      prior_versions_count: prior.length,
    }),
    ...(!record.active && lastInactive && { deactivated_at: lastInactive.deactivated_at }),
    ...(record.inactive_intervals.length > 0 && { inactive_intervals: structuredClone(record.inactive_intervals.slice(-64)) }),
    ...(destinationRef && { destination_ref: destinationRef }),
    configuration: structuredClone(record.configuration),
    accounts_with_exceptions: withExceptions.slice(0, INLINE_ACCOUNTS),
    accounts_with_exceptions_count: withExceptions.length,
    ...(overrides.length > 0 && {
      destination_override_refs: overrides.flatMap(override => {
        const ref = destinations.find(candidate => candidate.destination_id === override.destination_id)?.destination_ref;
        return ref ? [{ destination_id: String(override.destination_id), destination_ref: ref }] : [];
      }),
    }),
    ...(unauthorized.length > 0 && {
      accounts_unauthorized: unauthorized.slice(0, INLINE_ACCOUNTS),
      accounts_unauthorized_count: unauthorized.length,
    }),
  };
}

function priorVersion(version: SubscriptionVersion): Json {
  return {
    subscription_version: version.subscription_version,
    accepted_at: version.accepted_at,
    superseded_at: version.superseded_at!,
    configuration: structuredClone(version.configuration),
  };
}

/** One page of a subscription's accounts_with_exceptions, accounts_unauthorized, or prior_versions. */
export function subscriptionPage(
  record: SubscriptionRecord,
  extras: SubscriptionReadbackExtras,
  list: 'accounts_with_exceptions' | 'accounts_unauthorized' | 'prior_versions',
  pagination: { max_results?: number; cursor?: string } | undefined,
): Json {
  const items: Json[] = list === 'prior_versions'
    ? record.versions.slice(0, -1).reverse().map(priorVersion)
    : [...extras[list]].sort((a, b) => byteOrder(a.account_id, b.account_id)) as unknown as Json[];
  const max = Math.min(Math.max(pagination?.max_results ?? 50, 1), 100);
  const offset = pagination?.cursor && /^rsp_\d+$/.test(pagination.cursor) ? Number(pagination.cursor.slice(4)) : 0;
  const page = items.slice(offset, offset + max);
  const hasMore = offset + page.length < items.length;
  return {
    subscription_id: record.subscription_id,
    list,
    ...(list === 'prior_versions'
      ? { prior_versions: page }
      : list === 'accounts_unauthorized' ? { accounts_unauthorized: page } : { accounts_with_exceptions: page }),
    pagination: { has_more: hasMore, total_count: items.length, ...(hasMore && { cursor: `rsp_${offset + page.length}` }) },
  };
}

/** Per-offering cutover instants for an account timezone change (the probe's
 * set_account_timezone response). */
export function timezoneCutoverInstants(previousTimezone: string, timezone: string, atMs: number): Array<{ offering_id: string; effective_at: string }> {
  void timezone;
  if (!coverageModelHasZone(previousTimezone)) return [];
  return subscriptionOfferings()
    .filter(offering => offering.schedule.alignment === 'account_timezone')
    .map(offering => ({
      offering_id: offering.offering_id,
      effective_at: iso(boundariesAround(offering, previousTimezone, atMs).atOrAfter),
    }));
}

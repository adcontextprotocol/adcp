/**
 * Deterministic Core-tier reporting ledger for the public sales training
 * agent. This deliberately models the durable reporting contract rather
 * than reusing delivery metrics: a configuration creates period obligations;
 * a media-buy acceptance or a materialized report never does.
 *
 * The production SDK owns tool registration and wire validation. This module
 * owns only sandbox fixture state so the same runnable exercise can show the
 * otherwise hard-to-observe "missing first report" boundary immediately.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  GetReportingStatusRequest,
  GetReportingStatusResponse,
  ReportingObligation,
  ReportingRevision,
} from '@adcp/sdk';
import { ReportingDeliveryConfigurationSchema } from '@adcp/sdk/schemas';
import { getPool, isDatabaseInitialized } from '../db/client.js';
import { accountScopeFromRef } from './account-scope.js';
import type { AccountRef } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 31;
const RECOVERY_WINDOW_MS = 2 * HOUR_MS;
const TRAINING_SCHEMA_URI = 'https://test-agent.adcontextprotocol.org/reporting/schemas/delivery-summary-v1.json';
const TRAINING_DEFINITION_URI = 'https://test-agent.adcontextprotocol.org/reporting/definitions/delivery-summary-v1.json';

// Immutable documents advertised by the Core offering. Keep the exact bytes
// here (rather than a `res.json` object) so their published digest can be
// verified by a consumer without depending on an Express serialization detail.
export const TRAINING_REPORTING_ROW_SCHEMA_BYTES = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: TRAINING_SCHEMA_URI,
  type: 'object',
  additionalProperties: false,
  properties: {
    period_start: { type: 'string', format: 'date-time' },
    period_end: { type: 'string', format: 'date-time' },
    impressions: { type: 'integer', minimum: 0 },
  },
  required: ['period_start', 'period_end', 'impressions'],
});
export const TRAINING_REPORTING_DEFINITION_BYTES = JSON.stringify({
  contract_version: '1.0',
  media_type: 'application/vnd.adcp.reporting-definition+json',
  report_definition_id: 'training_delivery_summary_v1',
  reporting_profile: 'training_delivery_summary_v1',
  grain: 'one aggregate delivery summary per reporting period',
  source: {
    provider: { domain: 'test-agent.adcontextprotocol.org' },
    system: 'training-agent-deterministic-ledger',
    api_version: '1.0',
    query_semantics: { metrics: ['impressions'], reporting_timezone: 'UTC' },
  },
  calendar: { timezone_basis: 'utc' },
  metrics: [{ name: 'impressions', source_expression: 'sum(impressions)', aggregation: 'sum', unit: 'impressions' }],
  dimensions: [],
  restatement_policy: { source_requery_duration: 'PT0S', emit_only_on_content_change: true },
  finality_policies: [{ finality_policy_id: 'training_snapshot', basis: 'contractual_cutoff', duration_after_period_end: 'PT0S' }],
});
const TRAINING_DEFINITION_SHA256 = createHash('sha256').update(TRAINING_REPORTING_DEFINITION_BYTES).digest('hex');
const TRAINING_SCHEMA_SHA256 = createHash('sha256').update(TRAINING_REPORTING_ROW_SCHEMA_BYTES).digest('hex');

type CoreConfig = {
  delivery_config_id: string;
  delivery_config_version: number;
  offering_id: string;
  active: boolean;
  revocation_effective_at?: string;
  feed_purpose: 'pacing';
  report_definition_id: string;
  reporting_profile: string;
  scope: { all_media_buys: true } | { media_buy_ids: string[] };
  coverage_requirement: 'full' | 'allow_partial';
  required_finality: 'snapshot';
  reconciliation_mode: 'delivery_only';
  schedule: {
    period_duration: 'PT1H';
    alignment: 'utc';
    delivery_sla: 'PT1H';
  };
};

interface StoredConfig {
  config: CoreConfig;
  activatedAt: string;
  /** First instant at which this generation may not start another period. */
  deactivatedAt?: string;
  activeWindows: Array<{ start: string; end?: string }>;
}

interface ReportingMediaBuyCandidateState {
  effectiveAt: string;
  start: string;
  end: string;
  knownAt: string;
  packages: Array<{ packageId: string; supported: boolean }>;
}

interface ReportingLedger {
  /** Monotonic content version used to make snapshot identity collision-free. */
  version: number;
  /** The account's current resolved configuration state, for settings echoes. */
  configs: Map<string, StoredConfig>;
  /** Retained generations, including deactivated and superseded configurations. */
  history: StoredConfig[];
  virtualNow?: string;
  publishedRevisions: Map<string, ReportingRevision>;
  /** Sandbox-only negative fixture: expected periods intentionally absent from the ledger. */
  suppressedObligationIds: Set<string>;
  mediaBuyCandidates: Map<string, ReportingMediaBuyCandidateState[]>;
  obligationMediaBuyIds: Map<string, string[]>;
  obligationCoverage: Map<string, ReturnType<typeof emptyCoverage>>;
  /** One durable resource snapshot per pagination walk. */
  pageSnapshots: Map<string, StoredPageSnapshot>;
  /** Lightweight offsets into pageSnapshots. */
  pageCursors: Map<string, StoredPageCursor>;
}

const ledgers = new Map<string, ReportingLedger>();
const reportingAccountBindings = new Map<string, {
  accountId: string;
  account: AccountRef;
  accountState?: Record<string, unknown>;
}>();

function cacheReportingAccountBinding(
  principalScope: string,
  accountId: string,
  account: AccountRef,
  accountState?: Record<string, unknown>,
): void {
  const scopeKey = `${principalScope}\u001f${accountScopeFromRef(account)}`;
  const idKey = `${principalScope}\u001fa:${accountId}`;
  const preservedAccountState = accountState
    ?? reportingAccountBindings.get(scopeKey)?.accountState
    ?? reportingAccountBindings.get(idKey)?.accountState;
  const binding = {
    accountId,
    account: structuredClone(account),
    ...(preservedAccountState && { accountState: structuredClone(preservedAccountState) }),
  };
  reportingAccountBindings.set(scopeKey, binding);
  reportingAccountBindings.set(idKey, binding);
}

interface SerializedReportingLedger {
  version: number;
  current_generation_keys: string[];
  history: StoredConfig[];
  virtual_now?: string;
  published_revisions: Array<[string, ReportingRevision]>;
  suppressed_obligation_ids: string[];
  media_buy_candidates: Array<[string, ReportingMediaBuyCandidateState[]]>;
  obligation_media_buy_ids: Array<[string, string[]]>;
  obligation_coverage: Array<[string, ReturnType<typeof emptyCoverage>]>;
  page_snapshots?: Array<[string, StoredPageSnapshot]>;
  page_cursors: Array<[string, StoredPageCursor]>;
}

function emptyLedger(): ReportingLedger {
  return {
    version: 0,
    configs: new Map(),
    history: [],
    publishedRevisions: new Map(),
    suppressedObligationIds: new Set(),
    mediaBuyCandidates: new Map(),
    obligationMediaBuyIds: new Map(),
    obligationCoverage: new Map(),
    pageSnapshots: new Map(),
    pageCursors: new Map(),
  };
}

function serializeLedger(ledger: ReportingLedger): SerializedReportingLedger {
  return {
    version: ledger.version,
    current_generation_keys: [...ledger.configs.keys()],
    history: structuredClone(ledger.history),
    ...(ledger.virtualNow && { virtual_now: ledger.virtualNow }),
    published_revisions: [...ledger.publishedRevisions].map(([id, revision]) => [id, structuredClone(revision)]),
    suppressed_obligation_ids: [...ledger.suppressedObligationIds],
    media_buy_candidates: [...ledger.mediaBuyCandidates].map(([id, candidate]) => [id, structuredClone(candidate)]),
    obligation_media_buy_ids: [...ledger.obligationMediaBuyIds].map(([id, mediaBuyIdsValue]) => [id, [...mediaBuyIdsValue]]),
    obligation_coverage: [...ledger.obligationCoverage].map(([id, coverage]) => [id, structuredClone(coverage)]),
    page_snapshots: [...ledger.pageSnapshots].map(([id, snapshot]) => [id, structuredClone(snapshot)]),
    page_cursors: [...ledger.pageCursors].map(([token, cursor]) => [token, structuredClone(cursor)]),
  };
}

function deserializeLedger(value: SerializedReportingLedger): ReportingLedger {
  const history = structuredClone(value.history ?? []);
  const byGeneration = new Map(history.map(entry => [generationKey(entry.config), entry]));
  return {
    version: value.version ?? 0,
    configs: new Map((value.current_generation_keys ?? []).flatMap(key => {
      const entry = byGeneration.get(key);
      return entry ? [[key, entry] as const] : [];
    })),
    history,
    ...(value.virtual_now && { virtualNow: value.virtual_now }),
    publishedRevisions: new Map(value.published_revisions ?? []),
    suppressedObligationIds: new Set(value.suppressed_obligation_ids ?? []),
    mediaBuyCandidates: new Map((value.media_buy_candidates ?? []).map(([id, history]) => [
      id,
      Array.isArray(history) ? history : [{
        ...(history as unknown as Omit<ReportingMediaBuyCandidateState, 'effectiveAt'>),
        effectiveAt: (history as unknown as { knownAt: string }).knownAt,
      }],
    ])),
    obligationMediaBuyIds: new Map(value.obligation_media_buy_ids ?? []),
    obligationCoverage: new Map(value.obligation_coverage ?? []),
    pageSnapshots: new Map(value.page_snapshots ?? []),
    pageCursors: new Map((value.page_cursors ?? []).filter((entry): entry is [string, StoredPageCursor] => (
      typeof entry[1]?.snapshotId === 'string'
    ))),
  };
}

/**
 * Run one caller/account ledger operation under a cross-instance database
 * lock. Tests and local development without a database retain the deterministic
 * in-memory store; deployed training agents persist the exact ledger snapshot.
 */
export async function withDurableReportingLedger<T>(
  principal: string | undefined,
  accountId: string,
  persist: boolean,
  operation: () => T | Promise<T>,
  account?: AccountRef,
  accountState?: Record<string, unknown>,
): Promise<T> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  if (!isDatabaseInitialized()) {
    const result = await operation();
    if (persist && account) cacheReportingAccountBinding(principalScope, accountId, account, accountState);
    return result;
  }
  const cacheKey = callerScope(principal, accountId);
  const priorCache = ledgers.get(cacheKey);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${principalScope}\u001f${accountId}`],
    );
    const { rows } = await client.query<{
      ledger: SerializedReportingLedger | string;
      account_state: Record<string, unknown> | string | null;
    }>(
      `SELECT ledger, account_state
         FROM training_reporting_ledgers
        WHERE principal_scope = $1 AND account_id = $2
        FOR UPDATE`,
      [principalScope, accountId],
    );
    const stored = rows[0]?.ledger;
    const storedAccountState = typeof rows[0]?.account_state === 'string'
      ? JSON.parse(rows[0].account_state) as Record<string, unknown>
      : rows[0]?.account_state ?? undefined;
    ledgers.set(cacheKey, stored
      ? deserializeLedger(typeof stored === 'string' ? JSON.parse(stored) as SerializedReportingLedger : stored)
      : emptyLedger());
    const result = await operation();
    if (persist) {
      await client.query(
        `INSERT INTO training_reporting_ledgers (
           principal_scope, account_id, ledger, account_scope, account_ref, account_state, updated_at
         ) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (principal_scope, account_id) DO UPDATE SET
           ledger = EXCLUDED.ledger,
           account_scope = COALESCE(EXCLUDED.account_scope, training_reporting_ledgers.account_scope),
           account_ref = COALESCE(EXCLUDED.account_ref, training_reporting_ledgers.account_ref),
           account_state = COALESCE(EXCLUDED.account_state, training_reporting_ledgers.account_state),
           updated_at = EXCLUDED.updated_at`,
        [
          principalScope,
          accountId,
          JSON.stringify(serializeLedger(ledgerFor(principal, accountId))),
          account ? accountScopeFromRef(account) : null,
          account ? JSON.stringify(account) : null,
          accountState ? JSON.stringify(accountState) : null,
        ],
      );
    }
    await client.query('COMMIT');
    if (persist && account) {
      cacheReportingAccountBinding(principalScope, accountId, account, accountState ?? storedAccountState);
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (priorCache) ledgers.set(cacheKey, priorCache);
    else ledgers.delete(cacheKey);
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveReportingAccountDurably(
  principal: string | undefined,
  account: AccountRef,
): Promise<{ accountId: string; account: AccountRef; accountState?: Record<string, unknown> } | undefined> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  const scope = accountScopeFromRef(account);
  const cached = reportingAccountBindings.get(`${principalScope}\u001f${scope}`);
  if (cached) return structuredClone(cached);
  if (!isDatabaseInitialized()) return undefined;
  const lookupById = account.account_id !== undefined;
  const { rows } = await getPool().query<{
    account_id: string;
    account_ref: AccountRef | string | null;
    account_state: Record<string, unknown> | string | null;
  }>(
    `SELECT account_id, account_ref, account_state
       FROM training_reporting_ledgers
      WHERE principal_scope = $1 AND ${lookupById ? 'account_id' : 'account_scope'} = $2`,
    [principalScope, lookupById ? account.account_id : scope],
  );
  const row = rows[0];
  if (!row?.account_ref) return undefined;
  const storedAccount = typeof row.account_ref === 'string'
    ? JSON.parse(row.account_ref) as AccountRef
    : row.account_ref;
  const storedAccountState = typeof row.account_state === 'string'
    ? JSON.parse(row.account_state) as Record<string, unknown>
    : row.account_state ?? undefined;
  const binding = {
    accountId: row.account_id,
    account: storedAccount,
    ...(storedAccountState && { accountState: storedAccountState }),
  };
  cacheReportingAccountBinding(principalScope, row.account_id, storedAccount, storedAccountState);
  return structuredClone(binding);
}

export async function listReportingAccountsDurably(
  principal: string | undefined,
): Promise<Array<{ accountId: string; account: AccountRef; accountState?: Record<string, unknown> }>> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  if (isDatabaseInitialized()) {
    const { rows } = await getPool().query<{
      account_id: string;
      account_ref: AccountRef | string | null;
      account_state: Record<string, unknown> | string | null;
    }>(
      `SELECT account_id, account_ref, account_state
         FROM training_reporting_ledgers
        WHERE principal_scope = $1 AND account_ref IS NOT NULL`,
      [principalScope],
    );
    return rows.flatMap(row => {
      if (!row.account_ref) return [];
      const account = typeof row.account_ref === 'string'
        ? JSON.parse(row.account_ref) as AccountRef
        : row.account_ref;
      const accountState = typeof row.account_state === 'string'
        ? JSON.parse(row.account_state) as Record<string, unknown>
        : row.account_state ?? undefined;
      cacheReportingAccountBinding(principalScope, row.account_id, account, accountState);
      return [{ accountId: row.account_id, account, ...(accountState && { accountState }) }];
    });
  }
  const unique = new Map<string, { accountId: string; account: AccountRef; accountState?: Record<string, unknown> }>();
  for (const [key, binding] of reportingAccountBindings) {
    if (key.startsWith(`${principalScope}\u001f`)) unique.set(binding.accountId, binding);
  }
  return structuredClone([...unique.values()]);
}

function callerScope(principal: string | undefined, accountId: string): string {
  return `${principal && principal.length > 0 ? principal : 'anonymous'}\u001f${accountId}`;
}

function ledgerFor(principal: string | undefined, accountId: string): ReportingLedger {
  const key = callerScope(principal, accountId);
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = emptyLedger();
    ledgers.set(key, ledger);
  }
  return ledger;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stableId(kind: string, values: readonly string[]): string {
  const digest = createHash('sha256').update(values.join('\u001f')).digest('hex').slice(0, 24);
  return `${kind}.${digest}`;
}

function parseInstant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid reporting fixture time: ${value}`);
  return result;
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function canonicalCoreConfig(value: unknown): CoreConfig {
  const parsed = ReportingDeliveryConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid reporting_delivery_configs entry: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
  }
  const config = parsed.data as unknown as Record<string, unknown>;
  const schedule = config.schedule as Record<string, unknown> | undefined;
  const supported = config.offering_id === TRAINING_REPORTING_CORE_OFFERING.offering_id
    && config.feed_purpose === 'pacing'
    && config.report_definition_id === TRAINING_REPORTING_CORE_OFFERING.report_definition_id
    && config.reporting_profile === TRAINING_REPORTING_CORE_OFFERING.reporting_profile.id
    && config.required_finality === 'snapshot'
    && config.reconciliation_mode === 'delivery_only'
    && config.method === undefined
    && schedule?.period_duration === 'PT1H'
    && schedule?.alignment === 'utc'
    && schedule?.delivery_sla === 'PT1H';
  if (!supported) {
    throw new Error(`The training sales agent supports only the Core offering "${TRAINING_REPORTING_CORE_OFFERING.offering_id}".`);
  }
  return structuredClone(config) as unknown as CoreConfig;
}

function immutableConfig(config: CoreConfig): Omit<CoreConfig, 'active' | 'revocation_effective_at'> {
  const { active: _active, revocation_effective_at: _revocationEffectiveAt, ...immutable } = config;
  return immutable;
}

function generationKey(config: Pick<CoreConfig, 'delivery_config_id' | 'delivery_config_version'>): string {
  return `${config.delivery_config_id}\u001f${config.delivery_config_version}`;
}

function activeWindowAt(stored: StoredConfig, evaluatedAtMs: number): { start: string; end?: string } | undefined {
  return stored.activeWindows.find(window => (
    parseInstant(window.start) <= evaluatedAtMs
    && (window.end === undefined || evaluatedAtMs < parseInstant(window.end))
  ));
}

/** Validate an account replacement before mutating either account or ledger state. */
export function validateReportingConfigurations(configurations: unknown[]): void {
  const generations = new Set<string>();
  const activeIds = new Set<string>();
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const key = generationKey(config);
    if (generations.has(key)) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" version ${config.delivery_config_version} must be unique within an account.`);
    }
    generations.add(key);
    if (config.active && activeIds.has(config.delivery_config_id)) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" may have only one active generation.`);
    }
    if (config.active) activeIds.add(config.delivery_config_id);
  }
}

/** Validate replacement semantics before mutating account or ledger state. */
export function validateReportingConfigurationReplacement(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
): void {
  validateReportingConfigurations(configurations);
  // Validation also serves dry_run. Do not create an empty caller ledger just
  // to inspect an otherwise absent prior generation.
  const history = ledgers.get(callerScope(principal, accountId))?.history ?? [];
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const sameGeneration = history.find(entry => (
      entry.config.delivery_config_id === config.delivery_config_id
      && entry.config.delivery_config_version === config.delivery_config_version
    ));
    if (sameGeneration && JSON.stringify(immutableConfig(sameGeneration.config)) !== JSON.stringify(immutableConfig(config))) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" version ${config.delivery_config_version} is immutable.`);
    }
  }
}

/** Persist caller-owned replace semantics after a successful sync_accounts. */
export function replaceReportingConfigurations(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
  activatedAt = new Date().toISOString(),
): void {
  const ledger = ledgerFor(principal, accountId);
  const next = new Map<string, StoredConfig>();
  validateReportingConfigurationReplacement(principal, accountId, configurations);
  const incomingGenerations = new Set<string>();
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const key = generationKey(config);
    const shouldBeActive = config.active;
    incomingGenerations.add(key);
    const prior = ledger.configs.get(key);
    if (shouldBeActive) {
      for (const [otherKey, other] of ledger.configs) {
        if (otherKey === key || other.config.delivery_config_id !== config.delivery_config_id) continue;
        const otherWindow = other.activeWindows.at(-1);
        if (otherWindow && (!otherWindow.end || parseInstant(otherWindow.end) > parseInstant(activatedAt))) {
          otherWindow.end = activatedAt;
          other.deactivatedAt = activatedAt;
        }
      }
    }
    const existingGeneration = ledger.history.find(entry => (
      entry.config.delivery_config_id === config.delivery_config_id
      && entry.config.delivery_config_version === config.delivery_config_version
    ));
    const entry: StoredConfig = existingGeneration ?? {
      config,
      activatedAt: prior?.activatedAt ?? activatedAt,
      activeWindows: shouldBeActive ? [{ start: activatedAt }] : [],
    };
    if (existingGeneration) {
      const effectiveAt = config.revocation_effective_at ?? activatedAt;
      const openWindow = entry.activeWindows.at(-1);
      if (!shouldBeActive && openWindow && (!openWindow.end || parseInstant(openWindow.end) > parseInstant(effectiveAt))) {
        openWindow.end = effectiveAt;
        entry.deactivatedAt = effectiveAt;
      } else if (shouldBeActive && openWindow?.end && parseInstant(openWindow.end) > parseInstant(activatedAt)) {
        // Reactivation before a scheduled cutoff cancels that cutoff instead
        // of opening an overlapping window for the same generation.
        delete openWindow.end;
        delete entry.deactivatedAt;
      } else if (shouldBeActive && (!openWindow || openWindow.end)) {
        entry.activeWindows.push({ start: activatedAt });
        delete entry.deactivatedAt;
      }
      entry.config = config;
    } else if (!shouldBeActive) {
      entry.deactivatedAt = config.revocation_effective_at ?? activatedAt;
    }
    if (!existingGeneration) ledger.history.push(entry);
    next.set(key, entry);
  }
  for (const [key, prior] of ledger.configs) {
    if (!incomingGenerations.has(key)) {
      const openWindow = prior.activeWindows.at(-1);
      if (openWindow && (!openWindow.end || parseInstant(openWindow.end) > parseInstant(activatedAt))) {
        openWindow.end = activatedAt;
      }
      if (!prior.deactivatedAt || parseInstant(prior.deactivatedAt) > parseInstant(activatedAt)) {
        prior.deactivatedAt = activatedAt;
      }
    }
  }
  ledger.configs = next;
  ledger.version += 1;
}

/** Test/controller-only reset. Kept out of normal buyer inputs. */
export function prepareReportingCoreLifecycleProbe(principal: string | undefined, accountId: string): {
  account_id: string;
  resolved_configuration: CoreConfig;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  period: { start: string; end: string };
  expected_at: string;
  recovery_deadline: string;
  simulated_now: string;
} {
  const activatedAt = '2026-08-01T00:00:00.000Z';
  const simulatedNow = '2026-08-01T01:30:00.000Z';
  // `prepare` is a deterministic sandbox reset, not an ordinary account
  // settings retry. Discard any earlier wall-clock configuration for this
  // caller/account so the returned obligation identity and subsequent status
  // read always describe the same fixture generation.
  const nextVersion = (ledgers.get(callerScope(principal, accountId))?.version ?? 0) + 1;
  ledgers.set(callerScope(principal, accountId), {
    version: nextVersion,
    configs: new Map(),
    history: [],
    publishedRevisions: new Map(),
    suppressedObligationIds: new Set(),
    mediaBuyCandidates: new Map(),
    obligationMediaBuyIds: new Map(),
    obligationCoverage: new Map(),
    pageSnapshots: new Map(),
    pageCursors: new Map(),
  });
  replaceReportingConfigurations(principal, accountId, [TRAINING_REPORTING_CORE_CONFIGURATION], activatedAt);
  const ledger = ledgerFor(principal, accountId);
  ledger.virtualNow = simulatedNow;
  ledger.publishedRevisions.clear();
  return {
    account_id: accountId,
    resolved_configuration: structuredClone(TRAINING_REPORTING_CORE_CONFIGURATION),
    delivery_config_id: TRAINING_REPORTING_CORE_CONFIGURATION.delivery_config_id,
    delivery_config_version: TRAINING_REPORTING_CORE_CONFIGURATION.delivery_config_version,
    reporting_obligation_id: obligationId(accountId, TRAINING_REPORTING_CORE_CONFIGURATION, '2026-08-01T01:00:00.000Z'),
    period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    expected_at: '2026-08-01T02:00:00.000Z',
    recovery_deadline: '2026-08-01T04:00:00.000Z',
    simulated_now: simulatedNow,
  };
}

/** Create a deliberate seller-ledger omission for the buyer reconciliation lab. */
export function omitReportingCoreObligationProbe(principal: string | undefined, accountId: string): {
  account_id: string;
  resolved_configuration: CoreConfig;
  expected_reporting_obligation_id: string;
  omitted_period: { start: string; end: string };
  expected_at: string;
  simulated_now: string;
} {
  const ledger = ledgerFor(principal, accountId);
  const first = [...ledger.configs.values()][0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before omitting an obligation.');
  ledger.virtualNow = '2026-08-01T02:30:00.000Z';
  const periodEnd = '2026-08-01T02:00:00.000Z';
  const expectedId = obligationId(accountId, first.config, periodEnd);
  ledger.suppressedObligationIds.add(expectedId);
  ledger.version += 1;
  return {
    account_id: accountId,
    resolved_configuration: structuredClone(first.config),
    expected_reporting_obligation_id: expectedId,
    omitted_period: { start: '2026-08-01T01:00:00.000Z', end: periodEnd },
    expected_at: '2026-08-01T03:00:00.000Z',
    simulated_now: ledger.virtualNow,
  };
}

export function advanceReportingCoreLifecycleProbe(
  principal: string | undefined,
  accountId: string,
  targetHealth: 'delayed' | 'action_required',
): {
  account_id: string;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  expected_at: string;
  recovery_deadline: string;
  simulated_now: string;
  target_health: 'delayed' | 'action_required';
} {
  const ledger = ledgerFor(principal, accountId);
  if (ledger.configs.size === 0) throw new Error('Prepare the reporting_core_lifecycle_probe before advancing time.');
  const nextVirtualNow = targetHealth === 'delayed'
    ? '2026-08-01T02:05:00.000Z'
    : '2026-08-01T04:05:00.000Z';
  if (ledger.virtualNow !== nextVirtualNow) ledger.version += 1;
  ledger.virtualNow = nextVirtualNow;
  const first = ledger.history[0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before advancing time.');
  return {
    account_id: accountId,
    delivery_config_id: first.config.delivery_config_id,
    delivery_config_version: first.config.delivery_config_version,
    reporting_obligation_id: obligationId(accountId, first.config, '2026-08-01T01:00:00.000Z'),
    expected_at: '2026-08-01T02:00:00.000Z',
    recovery_deadline: '2026-08-01T04:00:00.000Z',
    simulated_now: ledger.virtualNow,
    target_health: targetHealth,
  };
}

/** Deterministic boundary control for source-schema regression tests. */
export function setReportingCoreLifecycleProbeClock(
  principal: string | undefined,
  accountId: string,
  simulatedNow: string,
): void {
  parseInstant(simulatedNow);
  const ledger = ledgerFor(principal, accountId);
  if (ledger.configs.size === 0) throw new Error('Prepare the reporting_core_lifecycle_probe before setting its clock.');
  if (ledger.virtualNow !== simulatedNow) ledger.version += 1;
  ledger.virtualNow = simulatedNow;
}

export function publishZeroRowReportingCoreLifecycleProbe(
  principal: string | undefined,
  accountId: string,
): {
  account_id: string;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  reporting_revision_id: string;
  row_count: 0;
  simulated_now: string;
} {
  const ledger = ledgerFor(principal, accountId);
  const first = [...ledger.configs.values()][0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before publishing a revision.');
  const end = '2026-08-01T01:00:00.000Z';
  const obligation = obligationId(accountId, first.config, end);
  const publishedAtMs = ledger.virtualNow ? parseInstant(ledger.virtualNow) : Date.now();
  const record = recordsFor(principal, accountId, [first], publishedAtMs)
    .find(candidate => candidate.obligation.reporting_obligation_id === obligation);
  if (!record) throw new Error('The reporting obligation is not yet available at the current fixture time.');
  const revision = zeroRowRevision(record.obligation, publishedAtMs);
  const priorRevision = ledger.publishedRevisions.get(obligation);
  if (JSON.stringify(priorRevision) !== JSON.stringify(revision)) ledger.version += 1;
  ledger.publishedRevisions.set(obligation, revision);
  return {
    account_id: accountId,
    delivery_config_id: first.config.delivery_config_id,
    delivery_config_version: first.config.delivery_config_version,
    reporting_obligation_id: obligation,
    reporting_revision_id: revisionId(obligation),
    row_count: 0,
    simulated_now: ledger.virtualNow ?? iso(Date.now()),
  };
}

function obligationId(accountId: string, config: CoreConfig, periodEnd: string): string {
  return stableId('reporting-obligation', [accountId, config.delivery_config_id, String(config.delivery_config_version), periodEnd]);
}

function revisionId(obligationIdValue: string): string {
  return stableId('reporting-revision', [obligationIdValue, 'zero-row-v1']);
}

interface ReportingCoverageFixture {
  status: 'full' | 'partial' | 'none' | 'unknown';
  evaluated_at: string;
  media_buy_ids: string[];
  fully_covered_media_buy_ids: string[];
  partially_covered_media_buy_ids: string[];
  unsupported_media_buy_ids: string[];
  unknown_media_buy_ids: string[];
  package_ids: string[];
  covered_package_ids: string[];
  unsupported_package_ids: string[];
  unknown_package_ids: string[];
  limitations: Array<{ reason: 'offering_unsupported'; media_buy_id: string; package_ids?: [string, ...string[]] }>;
}

function emptyCoverage(evaluatedAt: string, mediaBuyIds: string[]): ReportingCoverageFixture {
  return {
    status: 'full' as const,
    evaluated_at: evaluatedAt,
    media_buy_ids: mediaBuyIds,
    fully_covered_media_buy_ids: mediaBuyIds,
    partially_covered_media_buy_ids: [],
    unsupported_media_buy_ids: [],
    unknown_media_buy_ids: [],
    package_ids: [],
    covered_package_ids: [],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  };
}

function mediaBuyIds(config: CoreConfig): string[] {
  return 'media_buy_ids' in config.scope ? [...config.scope.media_buy_ids].sort() : [];
}

export interface ReportingMediaBuyCandidate {
  mediaBuyId: string;
  startTime: string;
  endTime: string;
  knownAt: string;
  effectiveAt?: string;
  packages?: Array<{ packageId: string; supported: boolean }>;
}

function candidateStateMap(candidates: ReportingMediaBuyCandidate[]): ReportingLedger['mediaBuyCandidates'] {
  return new Map(candidates.map(candidate => [candidate.mediaBuyId, [{
    effectiveAt: candidate.effectiveAt ?? candidate.knownAt,
    start: candidate.startTime,
    end: candidate.endTime,
    knownAt: candidate.knownAt,
    packages: structuredClone(candidate.packages ?? []),
  }]]));
}

function candidateAt(
  history: ReportingMediaBuyCandidateState[],
  instantMs: number,
): ReportingMediaBuyCandidateState | undefined {
  return [...history]
    .filter(candidate => parseInstant(candidate.effectiveAt) <= instantMs)
    .sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt))
    .at(-1);
}

/** Refresh the caller-authorized buy facts used to freeze all_media_buys scopes. */
export function setReportingMediaBuyCandidates(
  principal: string | undefined,
  accountId: string,
  candidates: ReportingMediaBuyCandidate[],
): void {
  const ledger = ledgerFor(principal, accountId);
  const incoming = candidateStateMap(candidates);
  // Accepted-buy identity, lifetime, and package applicability are historical
  // reporting facts. Merge newly observed buys, but never delete or rewrite a
  // previously captured candidate merely because a later live session or
  // product catalog no longer contains it.
  let changed = false;
  for (const [mediaBuyId, snapshots] of incoming) {
    const history = ledger.mediaBuyCandidates.get(mediaBuyId) ?? [];
    for (const snapshot of snapshots) {
      if (!history.some(existing => JSON.stringify(existing) === JSON.stringify(snapshot))) {
        history.push(snapshot);
        changed = true;
      }
    }
    history.sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt));
    ledger.mediaBuyCandidates.set(mediaBuyId, history);
  }
  if (changed) ledger.version += 1;
}

/**
 * Validate explicit scopes while the caller's authorization context is still
 * available. Unknown buy IDs are intentionally reported as one generic row
 * failure so account sync cannot be used as a cross-account existence oracle.
 */
export function validateReportingConfigurationScopes(
  configurations: unknown[],
  candidates: ReportingMediaBuyCandidate[],
): void {
  const byId = new Map(candidates.map(candidate => [candidate.mediaBuyId, candidate]));
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    if (!('media_buy_ids' in config.scope)) continue;
    const selected = config.scope.media_buy_ids.map(id => byId.get(id));
    if (selected.some(candidate => candidate === undefined)) {
      throw new Error('One or more reporting scope media buys are unavailable for this account.');
    }
    const support = selected.flatMap(candidate => candidate?.packages ?? [])
      .map(pkg => pkg.supported);
    const hasCovered = support.length === 0 || support.some(Boolean);
    const hasUnsupported = support.some(supported => !supported);
    if ((config.coverage_requirement === 'full' && hasUnsupported) || !hasCovered) {
      throw new Error('The selected reporting offering does not satisfy the requested media-buy scope coverage.');
    }
  }
}

function coverageForCandidates(
  config: CoreConfig,
  candidates: ReadonlyArray<readonly [string, ReportingMediaBuyCandidateState]>,
  knownMediaBuyIds: Set<string>,
  evaluatedAtMs: number,
): ReportingCoverageFixture {
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const mediaBuyIdsValue = requestedIds ?? candidates.map(([mediaBuyId]) => mediaBuyId);
  const fullyCovered: string[] = [];
  const partiallyCovered: string[] = [];
  const unsupported: string[] = [];
  const packageIds: string[] = [];
  const coveredPackageIds: string[] = [];
  const unsupportedPackageIds: string[] = [];
  const limitations: ReportingCoverageFixture['limitations'] = [];
  for (const [mediaBuyId, candidate] of candidates) {
    const packages = candidate.packages;
    const covered = packages.filter(pkg => pkg.supported).map(pkg => pkg.packageId);
    const rejected = packages.filter(pkg => !pkg.supported).map(pkg => pkg.packageId);
    packageIds.push(...packages.map(pkg => pkg.packageId));
    coveredPackageIds.push(...covered);
    unsupportedPackageIds.push(...rejected);
    if (packages.length === 0 || rejected.length === 0) fullyCovered.push(mediaBuyId);
    else if (covered.length > 0) partiallyCovered.push(mediaBuyId);
    else unsupported.push(mediaBuyId);
    if (rejected.length > 0) limitations.push({
      reason: 'offering_unsupported',
      media_buy_id: mediaBuyId,
      package_ids: rejected as [string, ...string[]],
    });
  }
  const hasCovered = fullyCovered.length > 0 || coveredPackageIds.length > 0;
  const hasExcluded = partiallyCovered.length > 0 || unsupported.length > 0;
  const unknownMediaBuyIds = requestedIds?.filter(id => !knownMediaBuyIds.has(id)) ?? [];
  return {
    status: unknownMediaBuyIds.length > 0
      ? (hasCovered || hasExcluded ? 'partial' : 'unknown')
      : hasExcluded ? (hasCovered ? 'partial' : 'none') : 'full',
    evaluated_at: iso(evaluatedAtMs),
    media_buy_ids: mediaBuyIdsValue,
    fully_covered_media_buy_ids: fullyCovered,
    partially_covered_media_buy_ids: partiallyCovered,
    unsupported_media_buy_ids: unsupported,
    unknown_media_buy_ids: unknownMediaBuyIds,
    package_ids: [...new Set(packageIds)].sort(),
    covered_package_ids: [...new Set(coveredPackageIds)].sort(),
    unsupported_package_ids: [...new Set(unsupportedPackageIds)].sort(),
    unknown_package_ids: [],
    limitations,
  };
}

function frozenCoverage(
  ledger: ReportingLedger,
  config: CoreConfig,
  obligationIdValue: string,
  periodStartMs: number,
  periodEndMs: number,
): ReportingCoverageFixture {
  const existing = ledger.obligationCoverage.get(obligationIdValue);
  if (existing) return structuredClone(existing);
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const candidates = (requestedIds
    ? requestedIds.flatMap(mediaBuyId => {
        const history = ledger.mediaBuyCandidates.get(mediaBuyId);
        const candidate = history && candidateAt(history, periodEndMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
    : [...ledger.mediaBuyCandidates].flatMap(([mediaBuyId, history]) => {
        const candidate = candidateAt(history, periodEndMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
      .filter(([, candidate]) => (
        parseInstant(candidate.knownAt) <= periodEndMs
        && parseInstant(candidate.start) < periodEndMs
        && parseInstant(candidate.end) > periodStartMs
      )))
    .sort(([left], [right]) => left.localeCompare(right));
  const mediaBuyIdsValue = requestedIds ?? candidates.map(([mediaBuyId]) => mediaBuyId);
  const coverage = coverageForCandidates(
    config,
    candidates,
    new Set(ledger.mediaBuyCandidates.keys()),
    periodEndMs,
  );
  ledger.obligationMediaBuyIds.set(obligationIdValue, mediaBuyIdsValue);
  ledger.obligationCoverage.set(obligationIdValue, coverage);
  ledger.version += 1;
  return structuredClone(coverage);
}

function currentCoverage(
  ledger: Pick<ReportingLedger, 'mediaBuyCandidates'>,
  config: CoreConfig,
  evaluatedAt: string,
): ReportingCoverageFixture {
  const evaluatedAtMs = parseInstant(evaluatedAt);
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const candidates = (requestedIds
    ? requestedIds.flatMap(mediaBuyId => {
        const history = ledger.mediaBuyCandidates.get(mediaBuyId);
        const candidate = history && candidateAt(history, evaluatedAtMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
    : [...ledger.mediaBuyCandidates].flatMap(([mediaBuyId, history]) => {
        const candidate = candidateAt(history, evaluatedAtMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      }).filter(([, candidate]) => (
        parseInstant(candidate.knownAt) <= evaluatedAtMs
        && parseInstant(candidate.start) <= evaluatedAtMs
        && parseInstant(candidate.end) > evaluatedAtMs
      )))
    .sort(([left], [right]) => left.localeCompare(right));
  return coverageForCandidates(
    config,
    candidates,
    new Set(ledger.mediaBuyCandidates.keys()),
    evaluatedAtMs,
  );
}

function aggregateCoverage(records: LedgerRecord[], evaluatedAt: string): ReportingCoverageFixture {
  if (records.length === 0) return emptyCoverage(evaluatedAt, []);
  const values = records.map(record => record.obligation.coverage as ReportingCoverageFixture);
  const unique = (items: string[]): string[] => [...new Set(items)].sort();
  const mediaBuyIdsValue = unique(values.flatMap(value => value.media_buy_ids));
  const unknown = new Set(values.flatMap(value => value.unknown_media_buy_ids));
  const unsupported = new Set(values.flatMap(value => value.unsupported_media_buy_ids).filter(id => !unknown.has(id)));
  const partial = new Set(values.flatMap(value => value.partially_covered_media_buy_ids)
    .filter(id => !unknown.has(id) && !unsupported.has(id)));
  const full = unique(values.flatMap(value => value.fully_covered_media_buy_ids)
    .filter(id => !unknown.has(id) && !unsupported.has(id) && !partial.has(id)));
  const unknownPackages = new Set(values.flatMap(value => value.unknown_package_ids));
  const unsupportedPackages = new Set(values.flatMap(value => value.unsupported_package_ids)
    .filter(id => !unknownPackages.has(id)));
  const coveredPackages = unique(values.flatMap(value => value.covered_package_ids)
    .filter(id => !unknownPackages.has(id) && !unsupportedPackages.has(id)));
  const hasCovered = full.length > 0 || partial.size > 0 || coveredPackages.length > 0;
  const hasExcluded = unsupported.size > 0 || partial.size > 0 || unknown.size > 0;
  return {
    status: !hasExcluded ? 'full' : hasCovered ? 'partial' : unknown.size > 0 ? 'unknown' : 'none',
    evaluated_at: evaluatedAt,
    media_buy_ids: mediaBuyIdsValue,
    fully_covered_media_buy_ids: full,
    partially_covered_media_buy_ids: [...partial].sort(),
    unsupported_media_buy_ids: [...unsupported].sort(),
    unknown_media_buy_ids: [...unknown].sort(),
    package_ids: unique(values.flatMap(value => value.package_ids)),
    covered_package_ids: coveredPackages,
    unsupported_package_ids: [...unsupportedPackages].sort(),
    unknown_package_ids: [...unknownPackages].sort(),
    limitations: values.flatMap(value => value.limitations).filter((limitation, index, all) => (
      all.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(limitation)) === index
    )),
  };
}

function healthFor(expectedAtMs: number, nowMs: number): 'waiting' | 'delayed' | 'action_required' {
  if (nowMs <= expectedAtMs) return 'waiting';
  return nowMs > expectedAtMs + RECOVERY_WINDOW_MS ? 'action_required' : 'delayed';
}

interface LedgerRecord {
  obligation: ReportingObligation;
  revision?: ReportingRevision;
}

function recordsFor(
  principal: string | undefined,
  accountId: string,
  configs: StoredConfig[],
  nowMs: number,
): LedgerRecord[] {
  const ledger = ledgerFor(principal, accountId);
  const records: LedgerRecord[] = [];
  const retentionStartMs = floorHour(nowMs) - RETENTION_DAYS * 24 * HOUR_MS;
  for (const stored of configs) {
    for (const window of stored.activeWindows) {
      const activatedMs = parseInstant(window.start);
      const firstStart = Math.max(floorHour(activatedMs + HOUR_MS - 1), retentionStartMs);
      const finalEnd = Math.min(
        floorHour(nowMs),
        window.end ? floorHour(parseInstant(window.end) + HOUR_MS - 1) : floorHour(nowMs),
      );
      for (let startMs = firstStart; startMs < finalEnd; startMs += HOUR_MS) {
      const endMs = startMs + HOUR_MS;
      // The obligation is committed only for snapshots strictly after its
      // boundary, never for a snapshot taken at the exact boundary.
      if (endMs >= nowMs) continue;
      const periodEnd = iso(endMs);
      const id = obligationId(accountId, stored.config, periodEnd);
      if (ledger.suppressedObligationIds.has(id)) continue;
      const coverage = frozenCoverage(ledger, stored.config, id, startMs, endMs);
      const ids = coverage.media_buy_ids;
      const revision = ledger.publishedRevisions.get(id);
      const published = revision !== undefined;
      const incompleteFullCoverage = stored.config.coverage_requirement === 'full'
        && coverage.status !== 'full';
      const health = incompleteFullCoverage
        ? 'action_required'
        : published ? 'complete' : healthFor(endMs + HOUR_MS, nowMs);
      const issues = incompleteFullCoverage ? [{
        issue_id: stableId('reporting-issue', [id, 'coverage-incomplete']),
        code: 'REPORTING_COVERAGE_INCOMPLETE' as const,
        severity: 'action_required' as const,
        responsible_party: 'seller' as const,
        recommended_action: 'change_reporting_scope' as const,
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        feed_purpose: stored.config.feed_purpose,
        ...(ids.length > 0 && { media_buy_ids: ids as [string, ...string[]] }),
        ...(coverage.unsupported_package_ids.length > 0 && {
          package_ids: coverage.unsupported_package_ids as [string, ...string[]],
        }),
        period_start: iso(startMs),
        period_end: periodEnd,
        expected_at: iso(endMs + HOUR_MS),
      }] : health === 'waiting' ? [] : published ? [] : [{
        issue_id: stableId('reporting-issue', [id, health]),
        code: 'REPORT_OVERDUE' as const,
        severity: health as 'delayed' | 'action_required',
        responsible_party: 'seller' as const,
        recommended_action: health === 'delayed' ? 'wait_for_retry' as const : 'contact_seller' as const,
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        feed_purpose: stored.config.feed_purpose,
        period_start: iso(startMs),
        period_end: periodEnd,
        expected_at: iso(endMs + HOUR_MS),
      }];
      const obligation: ReportingObligation = {
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        report_definition_id: stored.config.report_definition_id,
        feed_purpose: stored.config.feed_purpose,
        reporting_profile: stored.config.reporting_profile,
        account_id: accountId,
        media_buy_ids: ids,
        scope_resolved_at: periodEnd,
        coverage,
        period: { start: iso(startMs), end: periodEnd, source_timezone: 'UTC' },
        expected_at: iso(endMs + HOUR_MS),
        schedule: stored.config.schedule,
        required_finality: 'snapshot',
        reconciliation_mode: 'delivery_only',
        reconciliation_status: 'not_required',
        health,
        production_status: published ? 'published' : 'pending',
        revision_count: published ? 1 : 0,
        issues,
      };
      records.push({ obligation, ...(revision && { revision: structuredClone(revision) }) });
      }
    }
  }
  return records.sort((a, b) => a.obligation.period.start.localeCompare(b.obligation.period.start));
}

function zeroRowRevision(obligation: ReportingObligation, nowMs: number): ReportingRevision {
  return {
    reporting_revision_id: revisionId(obligation.reporting_obligation_id),
    report_definition_id: obligation.report_definition_id,
    report_definition_uri: TRAINING_DEFINITION_URI,
    report_definition_sha256: TRAINING_DEFINITION_SHA256,
    reporting_profile: obligation.reporting_profile,
    schema_version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    account_id: obligation.account_id,
    media_buy_ids: obligation.media_buy_ids,
    coverage: obligation.coverage,
    period: obligation.period,
    finality: 'snapshot',
    observed_at: iso(nowMs),
    data_through: obligation.period.end,
    data_through_precision: 'exact',
    row_count: 0,
    control_totals: [],
    created_at: iso(nowMs),
  };
}

function unavailable(view: GetReportingStatusRequest['view']): GetReportingStatusResponse {
  return {
    status: 'failed',
    view,
    failure_kind: 'lookup_unavailable',
    errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
  } as GetReportingStatusResponse;
}

export function reportingStatusUnavailable(
  view: GetReportingStatusRequest['view'],
): GetReportingStatusResponse {
  return unavailable(view);
}

function worstHealth(records: LedgerRecord[]): 'waiting' | 'complete' | 'delayed' | 'action_required' {
  if (records.some(record => record.obligation.health === 'action_required')) return 'action_required';
  if (records.some(record => record.obligation.health === 'delayed')) return 'delayed';
  if (records.length === 0 || records.every(record => record.obligation.health === 'complete')) return 'complete';
  return 'waiting';
}

function withinHalfOpenPeriod(record: LedgerRecord, period: GetReportingStatusRequest['period']): boolean {
  if (!period) return true;
  const start = parseInstant(period.start);
  const end = parseInstant(period.end);
  const recordStart = parseInstant(record.obligation.period.start);
  const recordEnd = parseInstant(record.obligation.period.end);
  return start < end && recordStart >= start && recordEnd <= end;
}

type PageResource = { kind: 'period' | 'revision'; record: LedgerRecord };
interface StoredPageSnapshot {
  scope: string;
  nowMs: number;
  expiresAtMs: number;
  resources: PageResource[];
  common: Record<string, unknown>;
}
interface StoredPageCursor {
  snapshotId: string;
  offset: number;
  expiresAtMs: number;
}
interface ResolvedPageSnapshot extends StoredPageSnapshot {
  snapshotId: string;
  offset: number;
}
const PAGE_CURSOR_TTL_MS = 15 * 60 * 1000;

function sweepPageCursors(ledger: ReportingLedger, nowMs = Date.now()): void {
  for (const [token, cursor] of ledger.pageCursors) {
    if (cursor.expiresAtMs <= nowMs) ledger.pageCursors.delete(token);
  }
  const referenced = new Set([...ledger.pageCursors.values()].map(cursor => cursor.snapshotId));
  for (const [snapshotId, snapshot] of ledger.pageSnapshots) {
    if (snapshot.expiresAtMs <= nowMs || !referenced.has(snapshotId)) {
      ledger.pageSnapshots.delete(snapshotId);
    }
  }
}

function cursorFor(
  ledger: ReportingLedger,
  snapshot: Omit<StoredPageSnapshot, 'expiresAtMs'>,
  offset: number,
  snapshotId?: string,
): string {
  sweepPageCursors(ledger);
  const resolvedSnapshotId = snapshotId ?? randomBytes(24).toString('base64url');
  const token = randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + PAGE_CURSOR_TTL_MS;
  if (!ledger.pageSnapshots.has(resolvedSnapshotId)) {
    ledger.pageSnapshots.set(resolvedSnapshotId, {
      ...snapshot,
      resources: structuredClone(snapshot.resources),
      common: structuredClone(snapshot.common),
      expiresAtMs,
    });
  } else {
    ledger.pageSnapshots.get(resolvedSnapshotId)!.expiresAtMs = expiresAtMs;
  }
  ledger.pageCursors.set(token, {
    snapshotId: resolvedSnapshotId,
    offset,
    expiresAtMs,
  });
  return token;
}

function snapshotFromCursor(
  ledger: ReportingLedger,
  cursor: string | undefined,
  scope: string,
): ResolvedPageSnapshot | undefined | null {
  sweepPageCursors(ledger);
  if (!cursor) return undefined;
  const pageCursor = ledger.pageCursors.get(cursor);
  const snapshot = pageCursor && ledger.pageSnapshots.get(pageCursor.snapshotId);
  if (!pageCursor || !snapshot || snapshot.scope !== scope) {
    if (pageCursor) ledger.pageCursors.delete(cursor);
    return null;
  }
  return {
    ...snapshot,
    snapshotId: pageCursor.snapshotId,
    offset: pageCursor.offset,
  };
}

/** First-class SDK handler body for get_reporting_status. */
export function getReportingStatusForAccount(
  params: GetReportingStatusRequest,
  principal: string | undefined,
  accountId: string,
): GetReportingStatusResponse {
  const ledger = ledgerFor(principal, accountId);
  const cursorScope = stableId('reporting-page', [
    callerScope(principal, accountId), JSON.stringify({
      delivery_config_ids: params.delivery_config_ids,
      media_buy_ids: params.media_buy_ids,
      feed_purposes: params.feed_purposes,
      period: params.period,
      health: params.health,
      finality: params.finality,
    }),
  ]);
  const snapshot = snapshotFromCursor(ledger, params.pagination?.cursor, cursorScope);
  if (snapshot === null) return unavailable(params.view);
  // Opaque server-held cursors pin both ledger_as_of and the complete resource
  // set. Callers cannot forge timestamps/offsets or observe concurrent writes
  // halfway through a paginated snapshot.
  const nowMs = snapshot?.nowMs ?? (ledger.virtualNow ? parseInstant(ledger.virtualNow) : Date.now());
  if (params.period && !(parseInstant(params.period.start) < parseInstant(params.period.end))) return unavailable(params.view);
  const retainedFromMs = floorHour(nowMs) - RETENTION_DAYS * 24 * HOUR_MS;
  if (params.period && parseInstant(params.period.start) < retainedFromMs) return unavailable(params.view);
  const horizonStartMs = params.period ? parseInstant(params.period.start) : retainedFromMs;
  const horizonEndMs = params.period ? parseInstant(params.period.end) : nowMs;
  const intersectsHorizon = (entry: StoredConfig) => entry.activeWindows.some(window => (
    parseInstant(window.start) < horizonEndMs
    && (window.end === undefined || parseInstant(window.end) > horizonStartMs)
  ));
  const current = [...ledger.configs.values()];
  const active = current.filter(entry => activeWindowAt(entry, nowMs) !== undefined);
  const requestedConfigIds = params.delivery_config_ids;
  if (requestedConfigIds?.some(id => !ledger.history.some(entry => entry.config.delivery_config_id === id))) {
    return unavailable(params.view);
  }
  const configs = requestedConfigIds
    ? ledger.history.filter(entry => requestedConfigIds.includes(entry.config.delivery_config_id) && intersectsHorizon(entry))
    : active;
  const knownMediaBuyIds = new Set([
    ...ledger.mediaBuyCandidates.keys(),
    ...[...ledger.obligationCoverage.values()].flatMap(coverage => coverage.media_buy_ids),
  ]);
  if (params.media_buy_ids?.some(id => !knownMediaBuyIds.has(id))) return unavailable(params.view);
  const records = recordsFor(principal, accountId, configs, nowMs)
    .filter(record => withinHalfOpenPeriod(record, params.period))
    .filter(record => !params.media_buy_ids
      || params.media_buy_ids.some(id => record.obligation.media_buy_ids.includes(id)))
    .filter(record => !params.feed_purposes || params.feed_purposes.includes(record.obligation.feed_purpose))
    .filter(record => !params.finality || params.finality.includes(record.obligation.required_finality));
  if (params.view === 'revision') {
    const revision = recordsFor(principal, accountId, ledger.history, nowMs).map(record => record.revision)
      .find((candidate): candidate is ReportingRevision => candidate?.reporting_revision_id === params.reporting_revision_id);
    if (!revision) return unavailable(params.view);
    return {
      status: 'completed',
      view: 'revision',
      ledger_snapshot_id: stableId('reporting-ledger', [callerScope(principal, accountId), iso(nowMs), String(ledger.version)]),
      ledger_as_of: iso(nowMs),
      account_id: accountId,
      revision,
      materializations: [],
      receipts: [],
      pagination: { has_more: false, total_count: 1 },
    } as GetReportingStatusResponse;
  }
  const issues = records.flatMap(record => record.obligation.issues);
  const periodEnd = params.period ? parseInstant(params.period.end) : floorHour(nowMs);
  const periodStart = params.period
    ? parseInstant(params.period.start)
    : configs.length > 0
      ? Math.max(retainedFromMs, Math.min(...configs.map(config => floorHour(parseInstant(config.activatedAt) + HOUR_MS - 1))))
      : floorHour(nowMs) - HOUR_MS;
  const scopeClosed = configs.length === 0 || periodEnd < nowMs;
  const health = records.length === 0 && !scopeClosed ? 'waiting' : worstHealth(records);
  const scope = {
    period_start: iso(periodStart),
    period_end: iso(periodEnd),
    // Closure is the fixed-period denominator, independent of whether a
    // revision has arrived. Missing-first-report must remain observable here.
    scope_closed: scopeClosed,
    ...(params.media_buy_ids && { media_buy_ids: [...params.media_buy_ids].sort() }),
    all_accessible_media_buys: params.media_buy_ids === undefined,
    delivery_config_generations: configs.map(entry => ({
      delivery_config_id: entry.config.delivery_config_id,
      delivery_config_version: entry.config.delivery_config_version,
      feed_purpose: entry.config.feed_purpose,
    })),
    feed_purposes: [...new Set(configs.map(entry => entry.config.feed_purpose))],
    finality: [...new Set(configs.map(entry => entry.config.required_finality))],
    ledger_retained_from: iso(retainedFromMs),
    coverage_complete: periodStart >= retainedFromMs,
  };
  const coverage = aggregateCoverage(records, iso(nowMs));
  const counts = {
    total: records.length,
    waiting: records.filter(record => record.obligation.health === 'waiting').length,
    healthy: 0,
    delayed: records.filter(record => record.obligation.health === 'delayed').length,
    action_required: records.filter(record => record.obligation.health === 'action_required').length,
    complete: records.filter(record => record.obligation.health === 'complete').length,
  };
  const common = {
    status: 'completed' as const,
    view: params.view,
    ledger_snapshot_id: stableId('reporting-ledger', [callerScope(principal, accountId), iso(nowMs), String(ledger.version)]),
    ledger_as_of: iso(nowMs),
    account_id: accountId,
    scope,
    health,
    coverage,
    data_through: records.filter(record => record.revision).at(-1)?.obligation.period.end ?? null,
    ...(!scopeClosed && { next_expected_at: iso(periodEnd + HOUR_MS) }),
    obligation_counts: counts,
    issues,
  };
  if (params.view === 'summary') return common as GetReportingStatusResponse;
  const filtered = params.health
    ? records.filter(record => params.health?.includes(record.obligation.health))
    : records;
  const currentResources: PageResource[] = filtered.flatMap(record => [
    { kind: 'period' as const, record },
    ...(record.revision ? [{ kind: 'revision' as const, record }] : []),
  ]);
  const resources = snapshot?.resources ?? currentResources;
  const responseCommon = snapshot?.common ?? common;
  const offset = snapshot?.offset ?? 0;
  const page = resources.slice(offset, offset + (params.pagination?.max_results ?? 100));
  const hasMore = offset + page.length < resources.length;
  return {
    ...responseCommon,
    view: 'periods',
    periods: page.filter(item => item.kind === 'period').map(item => item.record.obligation),
    revisions: page.filter(item => item.kind === 'revision').flatMap(item => item.record.revision ? [item.record.revision] : []),
    materializations: [],
    receipts: [],
    pagination: {
      has_more: hasMore,
      ...(hasMore && {
        cursor: cursorFor(
          ledger,
          { scope: cursorScope, nowMs, resources, common: responseCommon },
          offset + page.length,
          snapshot?.snapshotId,
        ),
      }),
      // A page walks ledger resources: one obligation and each retained revision.
      total_count: resources.length,
    },
  } as GetReportingStatusResponse;
}

export function clearReportingReliabilityStore(): void {
  ledgers.clear();
  reportingAccountBindings.clear();
}

/** Test-only process-cache loss without discarding the in-memory ledger. */
export function clearReportingAccountBindingCacheForTesting(): void {
  reportingAccountBindings.clear();
}

/** Test-only visibility into the accepted-buy history behind frozen coverage. */
export function reportingMediaBuyCandidateHistoryForTesting(
  principal: string | undefined,
  accountId: string,
  mediaBuyId: string,
): ReportingMediaBuyCandidateState[] {
  return structuredClone(ledgerFor(principal, accountId).mediaBuyCandidates.get(mediaBuyId) ?? []);
}

export async function replaceReportingConfigurationsDurably(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
  activatedAt = new Date().toISOString(),
  account?: AccountRef,
  mediaBuyCandidates?: ReportingMediaBuyCandidate[],
  accountState?: Record<string, unknown>,
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, true, () => {
    if (mediaBuyCandidates) {
      validateReportingConfigurationScopes(configurations, mediaBuyCandidates);
      setReportingMediaBuyCandidates(principal, accountId, mediaBuyCandidates);
    }
    replaceReportingConfigurations(principal, accountId, configurations, activatedAt);
  }, account, accountState);
}

/** Persist authoritative account ownership even when reporting is unconfigured. */
export async function bindReportingAccountDurably(
  principal: string | undefined,
  accountId: string,
  account: AccountRef,
  accountState?: Record<string, unknown>,
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, true, () => undefined, account, accountState);
}

/** Capture accepted-buy applicability before live catalog/session state can change. */
export async function captureReportingMediaBuyCandidateDurably(
  principal: string | undefined,
  accountId: string,
  account: AccountRef,
  candidate: ReportingMediaBuyCandidate,
): Promise<void> {
  const existingBinding = account.account_id
    ? await resolveReportingAccountDurably(principal, { account_id: accountId })
    : undefined;
  await withDurableReportingLedger(principal, accountId, true, () => {
    setReportingMediaBuyCandidates(principal, accountId, [candidate]);
  }, existingBinding?.account ?? account);
}

export async function validateReportingConfigurationReplacementDurably(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, false, () => {
    validateReportingConfigurationReplacement(principal, accountId, configurations);
  });
}

export async function reportingConfigurationStatesForAccountDurably(
  principal: string | undefined,
  accountId: string,
): Promise<Array<Record<string, unknown>>> {
  return await withDurableReportingLedger(principal, accountId, false, () => (
    reportingConfigurationStatesForAccount(principal, accountId)
  ));
}

export async function getReportingStatusForAccountDurably(
  params: GetReportingStatusRequest,
  principal: string | undefined,
  accountId: string,
  mediaBuyCandidates: Array<{
    mediaBuyId: string;
    startTime: string;
    endTime: string;
    knownAt: string;
    packages?: Array<{ packageId: string; supported: boolean }>;
  }>,
): Promise<GetReportingStatusResponse> {
  // A status read may commit the first frozen all_media_buys denominator for
  // an elapsed period, so it is a durable ledger mutation even though the
  // protocol task itself is read-only.
  return await withDurableReportingLedger(principal, accountId, true, () => {
    setReportingMediaBuyCandidates(principal, accountId, mediaBuyCandidates);
    return getReportingStatusForAccount(params, principal, accountId);
  });
}

/** Secret-free account projection for sync_accounts and list_accounts. */
export function reportingConfigurationStatesForAccount(
  principal: string | undefined,
  accountId: string,
): Array<Record<string, unknown>> {
  const ledger = ledgers.get(callerScope(principal, accountId));
  if (!ledger) return [];
  const evaluatedAt = new Date().toISOString();
  return [...ledger.configs.values()].map(stored => configurationState(stored, evaluatedAt, ledger));
}

/** Resolve a dry-run echo without creating a ledger or materializing obligations. */
export function projectedReportingConfigurationStates(
  configurations: unknown[],
  evaluatedAt: string,
  candidates: ReportingMediaBuyCandidate[] = [],
): Array<Record<string, unknown>> {
  validateReportingConfigurations(configurations);
  const coverageLedger = { mediaBuyCandidates: candidateStateMap(candidates) };
  return configurations.map(raw => {
    const config = canonicalCoreConfig(raw);
    return configurationState({
      config,
      activatedAt: evaluatedAt,
      activeWindows: config.active ? [{ start: evaluatedAt }] : [],
    }, evaluatedAt, coverageLedger);
  });
}

function configurationState(
  stored: StoredConfig,
  evaluatedAt: string,
  ledger: Pick<ReportingLedger, 'mediaBuyCandidates'>,
): Record<string, unknown> {
  const { config, activatedAt, deactivatedAt } = stored;
  const evaluatedAtMs = parseInstant(evaluatedAt);
  const activeWindow = activeWindowAt(stored, evaluatedAtMs);
  if (activeWindow) {
    const coverage = currentCoverage(ledger, config, evaluatedAt);
    if (config.coverage_requirement === 'full' && coverage.status !== 'full') {
      return {
        configuration: structuredClone(config),
        state: 'action_required',
        validated_at: evaluatedAt,
        activated_at: activeWindow.start,
        current_coverage: coverage,
        issues: [{
          issue_id: stableId('reporting-config-issue', [config.delivery_config_id, String(config.delivery_config_version), 'coverage-incomplete']),
          code: 'REPORTING_COVERAGE_INCOMPLETE',
          severity: 'action_required',
          responsible_party: 'seller',
          recommended_action: 'change_reporting_scope',
          delivery_config_id: config.delivery_config_id,
          delivery_config_version: config.delivery_config_version,
          feed_purpose: config.feed_purpose,
          ...(coverage.media_buy_ids.length > 0 && { media_buy_ids: coverage.media_buy_ids }),
          ...(coverage.unsupported_package_ids.length > 0 && { package_ids: coverage.unsupported_package_ids }),
        }],
      };
    }
    return {
      configuration: structuredClone(config),
      state: 'ready',
      validated_at: evaluatedAt,
      activated_at: activeWindow.start,
      current_coverage: coverage,
    };
  }
  const stoppedAt = [...stored.activeWindows]
    .reverse()
    .find(window => window.end !== undefined && parseInstant(window.end) <= evaluatedAtMs)?.end
    ?? deactivatedAt
    ?? activatedAt;
  return {
    configuration: structuredClone(config),
    state: 'inactive',
    deactivated_at: stoppedAt,
    publication_stopped_at: iso(floorHour(parseInstant(stoppedAt) + HOUR_MS - 1)),
  };
}

export const TRAINING_REPORTING_CORE_OFFERING = {
  offering_id: 'pacing-hourly-core',
  feed_purpose: 'pacing' as const,
  report_definition_id: 'training_delivery_summary_v1',
  report_definition_uri: TRAINING_DEFINITION_URI,
  report_definition_sha256: TRAINING_DEFINITION_SHA256,
  reporting_profile: {
    id: 'training_delivery_summary_v1',
    version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema' as const,
    schema_ref_policy: 'local_fragment_only' as const,
    grain: 'one aggregate delivery summary per reporting period',
    primary_keys: ['period_start'] as [string],
  },
  schedule: { period_duration: 'PT1H', alignment: 'utc' as const, delivery_sla: 'PT1H' },
  supported_finality: ['snapshot'] as ['snapshot'],
  reconciliation_mode: 'delivery_only' as const,
};

export const TRAINING_REPORTING_CORE_CONFIGURATION: CoreConfig = {
  delivery_config_id: 'training-pacing-core',
  delivery_config_version: 1,
  offering_id: TRAINING_REPORTING_CORE_OFFERING.offering_id,
  active: true,
  feed_purpose: 'pacing',
  report_definition_id: TRAINING_REPORTING_CORE_OFFERING.report_definition_id,
  reporting_profile: TRAINING_REPORTING_CORE_OFFERING.reporting_profile.id,
  scope: { all_media_buys: true },
  coverage_requirement: 'full',
  required_finality: 'snapshot',
  reconciliation_mode: 'delivery_only',
  schedule: { period_duration: 'PT1H', alignment: 'utc', delivery_sla: 'PT1H' },
};

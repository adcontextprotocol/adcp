/**
 * Session state for the training agent.
 *
 * Sessions are keyed by account identifier (open mode) or userId+moduleId
 * (training mode). Backed by @adcp/client's AdcpStateStore so state survives
 * across Fly.io machines (in production, via PostgresStateStore).
 *
 * Per request we cache loaded sessions in AsyncLocalStorage so multiple
 * handler calls within the same request share state without re-querying
 * the DB. Mutated sessions are flushed at the end of the request by
 * flushDirtySessions(), called from the MCP endpoint wrapper.
 *
 * Tests use InMemoryStateStore (no DB) — behaviour is identical from the
 * handlers' perspective.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionState, AccountRef, BrandRef, CreativeState } from './types.js';
import { cleanupExpiredTasks } from '@adcp/client';
import {
  InMemoryStateStore,
  PostgresStateStore,
  structuredSerialize,
  structuredDeserialize,
  cleanupExpiredIdempotency,
  type AdcpStateStore,
} from '@adcp/client/server';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { getAgentUrl } from './config.js';

const logger = createLogger('training-agent-state');

const SESSION_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MEDIA_BUYS_PER_SESSION = 100;
const MAX_CREATIVES_PER_SESSION = 500;
const MAX_PROPERTY_LISTS_PER_SESSION = 100;
const MAX_CONTENT_STANDARDS_PER_SESSION = 100;
const MAX_RIGHTS_GRANTS_PER_SESSION = 100;
const MAX_USAGE_RECORDS_PER_SESSION = 1000;
const SESSIONS_COLLECTION = 'training_sessions';

export {
  MAX_MEDIA_BUYS_PER_SESSION,
  MAX_CREATIVES_PER_SESSION,
  MAX_USAGE_RECORDS_PER_SESSION,
  MAX_PROPERTY_LISTS_PER_SESSION,
  MAX_CONTENT_STANDARDS_PER_SESSION,
  MAX_RIGHTS_GRANTS_PER_SESSION,
};

// ── Store factory ────────────────────────────────────────────────

let storeInstance: AdcpStateStore | null = null;

function getStore(): AdcpStateStore {
  if (storeInstance) return storeInstance;
  storeInstance = isDatabaseInitialized()
    ? new PostgresStateStore(getPool())
    : new InMemoryStateStore();
  return storeInstance;
}

/** Override the store (tests only — refuses to run in production). */
export function setStateStore(store: AdcpStateStore | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setStateStore is not allowed in production');
  }
  storeInstance = store;
}

// ── Per-request cache via AsyncLocalStorage ──────────────────────

interface RequestSessionCtx {
  sessions: Map<string, SessionState>;
  /** Serialized snapshot taken at load time. Compared at flush to detect real mutations. */
  snapshots: Map<string, string>;
}

const requestCtx = new AsyncLocalStorage<RequestSessionCtx>();

/** Wrap a request so getSession()/flushDirtySessions() use a per-request cache. */
export function runWithSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: RequestSessionCtx = { sessions: new Map(), snapshots: new Map() };
  return requestCtx.run(ctx, fn);
}

/**
 * Persist sessions that were actually mutated during the current request.
 *
 * Mutation is detected by comparing the current serialized shape to a snapshot
 * taken when the session was first loaded. Read-only accesses do not write,
 * eliminating unnecessary DB traffic on `get_*` / `list_*` tools.
 *
 * Size enforcement (5 MB default) and key validation live in the SDK's
 * state store — `store.put` throws `StateError('PAYLOAD_TOO_LARGE')` or
 * `StateError('INVALID_ID')` automatically. Failures bubble to the MCP
 * transport layer so operators notice in alert pipelines.
 *
 * Known limitation: concurrent requests against the same session key use
 * last-writer-wins semantics. Acceptable for the sandbox training agent where
 * storyboards are sequential. Production sellers should use per-entity
 * collections via @adcp/client's createAdcpServer instead.
 */
export async function flushDirtySessions(): Promise<void> {
  const ctx = requestCtx.getStore();
  if (!ctx || ctx.sessions.size === 0) return;
  const store = getStore();
  const errors: Array<{ key: string; err: unknown }> = [];
  for (const [key, session] of ctx.sessions) {
    const current = serializeSession(session);
    const currentJson = stableStringify(current);
    const snapshotJson = ctx.snapshots.get(key);
    if (snapshotJson === currentJson) continue;
    try {
      await store.put(SESSIONS_COLLECTION, key, current);
      ctx.snapshots.set(key, currentJson);
    } catch (err) {
      // The response has already been sent, so we can't surface to the
      // caller. Collect for an aggregate throw so the MCP transport
      // layer sees the failure and operators notice in alert pipelines.
      logger.error({ err, key }, 'Failed to flush training-agent session');
      errors.push({ key, err });
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Failed to flush ${errors.length} session(s): ${errors.map(e => e.key).join(', ')}`,
    );
  }
}

/**
 * Stable stringify for dirty-detection.
 *
 * Sort keys so object equality is positional-independent. Drop
 * `lastAccessedAt` — we update it on every read, so including it
 * would make every getSession() look dirty and defeat the
 * "only flush real mutations" invariant.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (k, v) => {
    if (k === 'lastAccessedAt') return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        if (key === 'lastAccessedAt') continue;
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

// ── Session shape helpers ────────────────────────────────────────

function createSession(): SessionState {
  const now = new Date();
  return {
    mediaBuys: new Map(),
    governancePlans: new Map(),
    governanceChecks: new Map(),
    governanceOutcomes: new Map(),
    propertyLists: new Map(),
    collectionLists: new Map(),
    contentStandards: new Map(),
    rightsGrants: new Map(),
    creatives: new Map(),
    signalActivations: new Map(),
    usageRecords: [],
    complyExtensions: {
      accountStatuses: new Map(),
      siSessions: new Map(),
      deliverySimulations: new Map(),
      budgetSimulations: new Map(),
      seededProducts: new Map(),
      seededPricingOptions: new Map(),
    },
    createdAt: now,
    lastAccessedAt: now,
  };
}

/**
 * Canonical compliance creative fixtures.
 *
 * Conformance storyboards reference these IDs by hardcoded value — e.g. the
 * `creative_ad_server` storyboard calls `list_creatives` with no filter and
 * asserts `creatives[0].pricing_options`, then calls `build_creative` /
 * `report_usage` against `campaign_hero_video`. The storyboard declares
 * `controller_seeding: true` to have the runner auto-fire `seed_creative`,
 * but the SDK side of that wiring (adcp-client#778) is still open.
 *
 * Session handlers consult this map as a read-through fallback:
 *  - `list_creatives` merges compliance fixtures in when the session has
 *    none synced (so storyboards that never sync still see them); filtered
 *    queries skip the fallback — an explicit `creative_ids` filter means
 *    the caller is asking for a specific, session-owned creative.
 *  - `build_creative` / `report_usage` fall through to the fixtures when a
 *    requested `creative_id` is not in the session map.
 *
 * Agent URL is resolved lazily so the default propagates correctly in CI
 * and local runs alike.
 */
export function getComplianceCreatives(): CreativeState[] {
  return [
    {
      creativeId: 'campaign_hero_video',
      formatId: { agent_url: getAgentUrl(), id: 'vast_30s' },
      name: 'Campaign Hero Video',
      status: 'approved',
      syncedAt: new Date(0).toISOString(),
      pricingOptionId: 'po_vast_30s_cpm',
    },
  ];
}

export function getComplianceCreative(id: string): CreativeState | undefined {
  return getComplianceCreatives().find(c => c.creativeId === id);
}

/**
 * Serialize a SessionState via the SDK's `structuredSerialize` (tagged
 * envelopes for Map/Date). Returns a JSON-safe Record.
 */
function serializeSession(session: SessionState): Record<string, unknown> {
  const persisted = {
    ...session,
    // `products` is deterministic from the catalog — dropped from persistence
    // so callers re-derive on the next request. Only `proposals` (session-
    // specific drafts from refine workflows) ride along.
    lastGetProductsContext: session.lastGetProductsContext?.proposals?.length
      ? { proposals: session.lastGetProductsContext.proposals }
      : undefined,
  };
  return structuredSerialize(persisted) as Record<string, unknown>;
}

/**
 * Hydrate a stored doc back into a SessionState.
 *
 * Security invariant (per #2283 security review): `structuredDeserialize`
 * walks untrusted JSONB via `Object.entries` and can reconstitute a Map
 * whose entries include a "constructor" or "__proto__" key. Those are safe
 * on Map lookups (`.get(k)` returns the stored value, not Object.prototype)
 * — but only as long as handlers never spread raw request payloads into
 * session state. A handler that does `session.propertyLists.set(id, req)`
 * verbatim would re-open the vector. Every existing handler builds
 * PropertyListState/MediaBuyState/etc field-by-field from validated
 * primitives, not raw spread. Maintainers: keep it that way.
 *
 * Map-field safety: each `SessionState` Map gets an explicit `asMap(...)`
 * override below. If you add a new Map field to `SessionState`, add a
 * matching line here or it will hydrate as a raw envelope object.
 */
function deserializeSession(data: Record<string, unknown>): SessionState {
  const hydrated = structuredDeserialize(data) as Partial<SessionState> & { lastGetProductsContext?: unknown };
  const fresh = createSession();
  const asMap = <V>(v: unknown, fallback: Map<string, V>): Map<string, V> =>
    v instanceof Map ? (v as Map<string, V>) : fallback;
  const hydratedComply = (hydrated.complyExtensions ?? {}) as Partial<SessionState['complyExtensions']>;
  return {
    ...fresh,
    ...hydrated,
    mediaBuys: asMap(hydrated.mediaBuys, fresh.mediaBuys),
    creatives: asMap(hydrated.creatives, fresh.creatives),
    signalActivations: asMap(hydrated.signalActivations, fresh.signalActivations),
    governancePlans: asMap(hydrated.governancePlans, fresh.governancePlans),
    governanceChecks: asMap(hydrated.governanceChecks, fresh.governanceChecks),
    governanceOutcomes: asMap(hydrated.governanceOutcomes, fresh.governanceOutcomes),
    propertyLists: asMap(hydrated.propertyLists, fresh.propertyLists),
    collectionLists: asMap(hydrated.collectionLists, fresh.collectionLists),
    contentStandards: asMap(hydrated.contentStandards, fresh.contentStandards),
    rightsGrants: asMap(hydrated.rightsGrants, fresh.rightsGrants),
    usageRecords: Array.isArray(hydrated.usageRecords) ? hydrated.usageRecords : [],
    complyExtensions: {
      accountStatuses: asMap(hydratedComply.accountStatuses, fresh.complyExtensions.accountStatuses),
      siSessions: asMap(hydratedComply.siSessions, fresh.complyExtensions.siSessions),
      deliverySimulations: asMap(hydratedComply.deliverySimulations, fresh.complyExtensions.deliverySimulations),
      budgetSimulations: asMap(hydratedComply.budgetSimulations, fresh.complyExtensions.budgetSimulations),
      seededProducts: asMap(hydratedComply.seededProducts, fresh.complyExtensions.seededProducts),
      seededPricingOptions: asMap(hydratedComply.seededPricingOptions, fresh.complyExtensions.seededPricingOptions),
      forcedCreateMediaBuyArm: hydratedComply.forcedCreateMediaBuyArm,
    },
    lastGetProductsContext: (hydrated.lastGetProductsContext as SessionState['lastGetProductsContext']) ?? undefined,
    createdAt: hydrated.createdAt instanceof Date ? hydrated.createdAt : fresh.createdAt,
    lastAccessedAt: hydrated.lastAccessedAt instanceof Date ? hydrated.lastAccessedAt : fresh.lastAccessedAt,
  };
}

// ── Public session API (async) ───────────────────────────────────

/**
 * Get or create a session for the given key.
 *
 * Within a single request (wrapped by runWithSessionContext), the same
 * SessionState object is returned on repeat calls, letting handlers mutate
 * freely. Mutations are persisted at end of request by flushDirtySessions().
 *
 * Between requests, a fresh read from the store happens, so different Fly
 * machines see each other's writes.
 */
export async function getSession(key: string): Promise<SessionState> {
  const ctx = requestCtx.getStore();
  if (ctx) {
    const cached = ctx.sessions.get(key);
    if (cached) return cached;
  }

  let session: SessionState | undefined;
  try {
    const storedShape = await getStore().get<Record<string, unknown>>(SESSIONS_COLLECTION, key);
    if (storedShape) session = deserializeSession(storedShape);
  } catch (err) {
    logger.warn({ err, key }, 'Failed to load session from store; creating fresh');
  }
  if (!session) {
    session = createSession();
  }
  session.lastAccessedAt = new Date();

  if (ctx) {
    ctx.sessions.set(key, session);
    // Snapshot the round-trip shape (serialize after deserialize) so any
    // normalization done by (de)serialize doesn't register as a mutation.
    // stableStringify drops lastAccessedAt so "touch-only" reads don't flush.
    ctx.snapshots.set(key, stableStringify(serializeSession(session)));
  }
  return session;
}


const MAX_DOMAIN_LEN = 253; // RFC 1035 max hostname length
const MAX_ACCOUNT_ID_LEN = 128;
const SAFE_DOMAIN_RE = /^[a-z0-9.-]+$/i;
const SAFE_ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]+$/;

function safeKey(value: string | undefined, max: number, pattern: RegExp): string | null {
  if (!value || value.length === 0 || value.length > max) return null;
  if (!pattern.test(value)) return null;
  return value;
}

/** Derive a session key from the request context.
 *
 * Rejects malformed domain/account_id values — they become part of a Postgres
 * primary key, so we bound length and restrict charset to prevent bloating
 * the adcp_state table with arbitrary caller-supplied data.
 *
 * Open mode preference order: brand.domain (when present) > account.account_id
 * > plans[0].brand.domain > 'default'. Brand-domain-first matches what the
 * @adcp/client storyboard runner injects via `applyBrandInvariant` on every
 * request — so a chain like `create_media_buy(account.account_id+brand)`
 * → `get_media_buys(brand only)` stays in one session instead of writing
 * to `open:<account_id>` and then reading from `open:<brand.domain>`.
 *
 * plans[0].brand.domain is a last-resort fallback for `sync_plans` calls that
 * carry brand identity inside the plans array rather than at the top level —
 * the sync-plans-request schema defines `brand` on each plan and forbids
 * `account` inside plan items. Callers should still prefer top-level `brand`
 * or `account.brand` when possible; this exists so existing governance
 * storyboards don't land in `open:default`. Mixed-brand `plans` batches
 * collapse to the first plan's brand, which is fine for training-agent
 * semantics (single-tenant per session).
 *
 * Sandbox-style storyboards mix the two shapes across steps; production
 * sellers that key by account_id should run outside this codepath (or set
 * the spec's `account` invariant on every step).
 */
export function sessionKeyFromArgs(
  args: { account?: AccountRef; brand?: BrandRef; plans?: unknown },
  mode: 'open' | 'training',
  userId?: string,
  moduleId?: string,
): string {
  if (mode === 'training' && userId) {
    const safeUser = safeKey(userId, 128, SAFE_ACCOUNT_ID_RE) ?? 'default';
    const safeModule = safeKey(moduleId, 128, SAFE_ACCOUNT_ID_RE) ?? 'default';
    return `training:${safeUser}:${safeModule}`;
  }
  const account = args.account;
  const domain = account?.brand?.domain ?? args.brand?.domain;
  const safeDomain = safeKey(domain, MAX_DOMAIN_LEN, SAFE_DOMAIN_RE);
  if (safeDomain) {
    // DNS is case-insensitive — normalise so Example.com and example.com share a session.
    return `open:${safeDomain.toLowerCase()}`;
  }
  if (domain && !safeDomain) {
    logger.debug({ domain }, 'Rejected brand.domain as session key; falling back');
  }
  if (account?.account_id) {
    const safe = safeKey(account.account_id, MAX_ACCOUNT_ID_LEN, SAFE_ACCOUNT_ID_RE);
    if (safe) return `open:${safe}`;
  }
  if (Array.isArray(args.plans) && args.plans.length > 0) {
    const first = args.plans[0] as { brand?: BrandRef } | undefined;
    const planDomain = first?.brand?.domain;
    const safePlanDomain = safeKey(planDomain, MAX_DOMAIN_LEN, SAFE_DOMAIN_RE);
    if (safePlanDomain) return `open:${safePlanDomain.toLowerCase()}`;
    if (planDomain && !safePlanDomain) {
      logger.debug({ domain: planDomain }, 'Rejected plans[0].brand.domain as session key; falling back');
    }
  }
  return 'open:default';
}

// ── TTL cleanup ──────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Start the TTL cleanup interval. Deletes stale sessions from the store. */
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      if (isDatabaseInitialized()) {
        const { rowCount } = await getPool().query(
          `DELETE FROM adcp_state WHERE collection = $1 AND updated_at < NOW() - ($2 || ' milliseconds')::interval`,
          [SESSIONS_COLLECTION, String(SESSION_TTL_MS)],
        );
        if ((rowCount ?? 0) > 0) {
          logger.info({ deleted: rowCount }, 'Cleaned up expired training-agent sessions');
        }
        const taskDeleted = await cleanupExpiredTasks(getPool());
        if (taskDeleted > 0) {
          logger.info({ deleted: taskDeleted }, 'Cleaned up expired MCP tasks');
        }
        const idempDeleted = await cleanupExpiredIdempotency(getPool());
        if (idempDeleted > 0) {
          logger.info({ deleted: idempDeleted }, 'Cleaned up expired idempotency entries');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Session/task cleanup failed');
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Search every persisted session for the first one that matches a
 * predicate. Tools whose published input schema omits `account` (SDK
 * auto-generated schemas for log_event, provide_performance_feedback,
 * report_plan_outcome, etc.) land on `open:default` while earlier
 * writes by sync_event_sources / create_media_buy / sync_plans went to
 * `open:<brand.domain>`. This helper lets handlers keep their primary
 * session lookup and fall back to a cross-session scan.
 *
 * Iterates the per-request cache first (fresh writes), then the
 * persisted store (listed in pages of 100).
 */
export async function findSessionMatching(predicate: (s: SessionState) => boolean): Promise<SessionState | null> {
  const ctx = requestCtx.getStore();
  if (ctx) {
    for (const session of ctx.sessions.values()) {
      if (predicate(session)) return session;
    }
  }
  const store = storeInstance;
  if (!store) return null;
  try {
    const page = await store.list<Record<string, unknown>>(SESSIONS_COLLECTION, { limit: 100 });
    for (const row of page.items ?? []) {
      const session = deserializeSession(row);
      if (predicate(session)) return session;
    }
  } catch (err) {
    logger.warn({ err }, 'findSessionMatching: store list failed');
  }
  return null;
}

export function findMediaBuyAcrossSessions(mediaBuyId: string): Promise<SessionState | null> {
  return findSessionMatching(s => s.mediaBuys.has(mediaBuyId));
}

export function findGovernancePlanAcrossSessions(planId: string): Promise<SessionState | null> {
  return findSessionMatching(s => s.governancePlans.has(planId));
}

/** Clear all sessions (tests only). */
export async function clearSessions(): Promise<void> {
  const ctx = requestCtx.getStore();
  if (ctx) {
    ctx.sessions.clear();
    ctx.snapshots.clear();
  }
  const store = storeInstance;
  if (!store) return;
  if (store instanceof InMemoryStateStore) {
    store.clear();
  } else if (store instanceof PostgresStateStore) {
    await store.clearCollection(SESSIONS_COLLECTION);
  }
  // Other AdcpStateStore implementations: no-op. Tests should inject a known store.
}


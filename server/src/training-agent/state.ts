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
import type {
  SessionState, AccountRef, BrandRef,
  MediaBuyState, CreativeState, SignalActivationState, GovernancePlanState,
  GovernanceCheckState, GovernanceOutcomeState, PropertyListState,
  CollectionListState, ContentStandardsState, RightsGrantState, UsageRecord,
} from './types.js';
import { cleanupExpiredTasks } from '@adcp/client';
import {
  InMemoryStateStore,
  PostgresStateStore,
  type AdcpStateStore,
} from '@adcp/client/server';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

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
  /** Set by the dispatcher when a handler throws. flushDirtySessions() refuses to
   * persist state from a request that bailed mid-way — we'd risk writing partially
   * mutated data. */
  handlerFailed: boolean;
}

const requestCtx = new AsyncLocalStorage<RequestSessionCtx>();

/** Wrap a request so getSession()/flushDirtySessions() use a per-request cache. */
export function runWithSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: RequestSessionCtx = { sessions: new Map(), snapshots: new Map(), handlerFailed: false };
  return requestCtx.run(ctx, fn);
}

/** Mark the current request as failed so subsequent flushDirtySessions() is a no-op. */
export function markHandlerFailed(): void {
  const ctx = requestCtx.getStore();
  if (ctx) ctx.handlerFailed = true;
}

const MAX_SESSION_JSON_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Persist sessions that were actually mutated during the current request.
 *
 * Mutation is detected by comparing the current serialized shape to a snapshot
 * taken when the session was first loaded. Read-only accesses do not write,
 * eliminating unnecessary DB traffic on `get_*` / `list_*` tools.
 *
 * Known limitation: concurrent requests against the same session key use
 * last-writer-wins semantics. Acceptable for the sandbox training agent where
 * storyboards are sequential. Production sellers should use per-entity
 * collections via @adcp/client's createAdcpServer instead.
 */
export async function flushDirtySessions(): Promise<void> {
  const ctx = requestCtx.getStore();
  if (!ctx || ctx.sessions.size === 0) return;
  if (ctx.handlerFailed) {
    logger.warn({ keys: [...ctx.sessions.keys()] }, 'Skipping flush: handler threw mid-request');
    return;
  }
  const store = getStore();
  for (const [key, session] of ctx.sessions) {
    const current = serializeSession(session);
    const currentJson = stableStringify(current);
    const snapshotJson = ctx.snapshots.get(key);
    if (snapshotJson === currentJson) continue;
    if (currentJson.length > MAX_SESSION_JSON_BYTES) {
      logger.warn(
        { key, bytes: currentJson.length },
        'Skipping session flush: serialized state exceeds size cap',
      );
      continue;
    }
    try {
      await store.put(SESSIONS_COLLECTION, key, current);
      ctx.snapshots.set(key, currentJson);
    } catch (err) {
      logger.error({ err, key }, 'Failed to flush training-agent session');
    }
  }
}

/** Stable stringify: sort keys so object equality is positional-independent. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
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
    createdAt: now,
    lastAccessedAt: now,
  };
}

/** Serialize a SessionState to a JSON-safe object for the state store.
 *
 * `lastGetProductsContext.products` is deterministic from the catalog, so we
 * drop it from persistence and let callers recompute on next request.
 * `proposals` (session-specific drafts) are persisted.
 */
function serializeSession(session: SessionState): Record<string, unknown> {
  return {
    mediaBuys: Object.fromEntries(session.mediaBuys),
    creatives: Object.fromEntries(session.creatives),
    signalActivations: Object.fromEntries(session.signalActivations),
    governancePlans: Object.fromEntries(session.governancePlans),
    governanceChecks: Object.fromEntries(session.governanceChecks),
    governanceOutcomes: Object.fromEntries(session.governanceOutcomes),
    propertyLists: Object.fromEntries(session.propertyLists),
    collectionLists: Object.fromEntries(session.collectionLists),
    contentStandards: Object.fromEntries(session.contentStandards),
    rightsGrants: Object.fromEntries(session.rightsGrants),
    usageRecords: session.usageRecords,
    lastGetProductsProposals: session.lastGetProductsContext?.proposals,
    createdAt: session.createdAt.toISOString(),
    lastAccessedAt: session.lastAccessedAt.toISOString(),
  };
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deserialize a stored doc back into a SessionState with Map/Date types. */
function deserializeSession(data: Record<string, unknown>): SessionState {
  const asMap = <V>(obj: unknown): Map<string, V> => {
    if (!obj || typeof obj !== 'object') return new Map();
    const entries = Object.entries(obj as Record<string, V>)
      .filter(([k]) => !RESERVED_KEYS.has(k));
    return new Map(entries);
  };
  const asDate = (v: unknown): Date => {
    if (typeof v === 'string') return new Date(v);
    return new Date();
  };
  return {
    mediaBuys: asMap<MediaBuyState>(data.mediaBuys),
    creatives: asMap<CreativeState>(data.creatives),
    signalActivations: asMap<SignalActivationState>(data.signalActivations),
    governancePlans: asMap<GovernancePlanState>(data.governancePlans),
    governanceChecks: asMap<GovernanceCheckState>(data.governanceChecks),
    governanceOutcomes: asMap<GovernanceOutcomeState>(data.governanceOutcomes),
    propertyLists: asMap<PropertyListState>(data.propertyLists),
    collectionLists: asMap<CollectionListState>(data.collectionLists),
    contentStandards: asMap<ContentStandardsState>(data.contentStandards),
    rightsGrants: asMap<RightsGrantState>(data.rightsGrants),
    usageRecords: Array.isArray(data.usageRecords) ? data.usageRecords as UsageRecord[] : [],
    // Only proposals persist; products are deterministic from the catalog, so callers
    // re-derive on the next request via the fallback in the get_products handler.
    lastGetProductsContext: Array.isArray(data.lastGetProductsProposals) && data.lastGetProductsProposals.length > 0
      ? { proposals: data.lastGetProductsProposals as NonNullable<SessionState['lastGetProductsContext']>['proposals'] }
      : undefined,
    createdAt: asDate(data.createdAt),
    lastAccessedAt: asDate(data.lastAccessedAt),
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
  let storedShape: Record<string, unknown> | null = null;
  try {
    storedShape = await getStore().get<Record<string, unknown>>(SESSIONS_COLLECTION, key);
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
    // Snapshot the shape we loaded (or serialize the freshly-created session).
    // flushDirtySessions() compares against this snapshot to decide whether to write.
    ctx.snapshots.set(key, stableStringify(storedShape ?? serializeSession(session)));
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
 */
export function sessionKeyFromArgs(
  args: { account?: AccountRef; brand?: BrandRef },
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
  if (account?.account_id) {
    const safe = safeKey(account.account_id, MAX_ACCOUNT_ID_LEN, SAFE_ACCOUNT_ID_RE);
    if (safe) return `open:${safe}`;
  }
  const domain = account?.brand?.domain ?? args.brand?.domain;
  const safeDomain = safeKey(domain, MAX_DOMAIN_LEN, SAFE_DOMAIN_RE);
  // DNS is case-insensitive — normalise so Example.com and example.com share a session.
  return `open:${safeDomain ? safeDomain.toLowerCase() : 'default'}`;
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
    return;
  }
  // PostgresStateStore exposes clearCollection (not on the interface).
  const maybeClear = (store as { clearCollection?: (c: string) => Promise<number> }).clearCollection;
  if (typeof maybeClear === 'function') {
    await maybeClear.call(store, SESSIONS_COLLECTION);
  }
}


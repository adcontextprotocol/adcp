/**
 * Idempotency wiring for the training agent.
 *
 * Facade over `@adcp/sdk/server`'s idempotency backends, implementing the
 * spec behaviour (RFC 8785 JCS payload hash, atomic hash-aware
 * putIfAbsent claim, ±60s clock-skew TTL, exclusion list for
 * `idempotency_key`, `context`, `governance_context`, and
 * `push_notification_config.authentication.credentials`).
 *
 * What this module adds on top:
 *
 * - `MUTATING_TOOLS` / `isMutatingTool` — the spec-wired set of tools that
 *   require `idempotency_key`. Derived from
 *   `static/schemas/source/**\/*-request.json` at test time (see
 *   `idempotency.test.ts` drift guard).
 * - `validateKeyFormat` — the regex gate applied before the store is
 *   touched, so a malformed key never influences cache timing.
 * - `scopedPrincipal` — account-partitions the cache when the shared
 *   public sandbox token is in use (otherwise every caller on that token
 *   sees the same oracle).
 * - `getIdempotencyStore` — returns a process-wide store backed by
 *   Postgres when a DB pool is available, in-memory otherwise.
 */

import {
  memoryBackend,
  pgBackend,
  hashPayload,
  type IdempotencyStore,
  type IdempotencyBackend,
  type IdempotencyCheckResult,
} from '@adcp/sdk/server';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import { randomUUID } from 'node:crypto';

export const REPLAY_TTL_SECONDS = 86400;

const MIN_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 604800;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const IN_FLIGHT_TTL_SECONDS = 120;
const TRANSIENT_ERROR_TTL_SECONDS = 10;
const IN_FLIGHT_RETRY_HINT_CAP_SECONDS = 30;
const CLAIM_SAVE_SAFETY_SECONDS = 30;
const SCOPE_SEPARATOR = '\u001F';
const PENDING_OWNER_FIELD = '__adcp_pending_owner';
const RETRYABLE_HASH_PREFIX = '__adcp_retryable__:';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

/**
 * Tasks whose request schemas require `idempotency_key`.
 * Derived from static/schemas/source/**\/*-request.json — every schema whose
 * top-level `required` list includes `idempotency_key` maps to the
 * corresponding tool. The regression test in idempotency.test.ts re-derives
 * this set from the schemas at test time and asserts equality, so drift
 * between this list and the schemas will fail CI.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'accept_proposal',
  'acquire_rights',
  'activate_signal',
  'build_creative',
  'buy_products',
  'calibrate_content',
  'create_collection_list',
  'create_content_standards',
  'create_media_buy',
  'create_property_list',
  'creative_approval',
  'control_media_buy',
  'delete_collection_list',
  'delete_property_list',
  'decline_proposals',
  'log_event',
  'provide_performance_feedback',
  'request_proposals',
  'refine_proposals',
  'report_plan_adjustment',
  'report_plan_outcome',
  'report_usage',
  'si_initiate_session',
  'si_send_message',
  'sync_accounts',
  'sync_agent_notification_configs',
  'sync_audiences',
  'sync_catalogs',
  'sync_creatives',
  'sync_event_sources',
  'sync_governance',
  'sync_plans',
  'update_collection_list',
  'update_content_standards',
  'update_media_buy',
  'update_property_list',
  'update_rights',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

export function validateKeyFormat(key: unknown): key is string {
  return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Build a cache-scoping principal from the auth layer's principal string
 * and the caller-supplied account reference.
 *
 * The public test token (`static:public`) is shared across all sandbox
 * callers, so scoping only by auth principal would pool every buyer into
 * one key-space — the three-state response (miss / conflict / expired)
 * would then be an observable oracle across callers (security.mdx
 * §"three-state response"). Account-level partitioning contains the
 * oracle to keys a caller could already enumerate for their own account.
 */
export function scopedPrincipal(
  authPrincipal: string,
  accountScope: string | undefined,
): string {
  // `\u001F` (unit separator) keeps auth principals that contain `:` (like
  // `workos:org_…`) unambiguous even when the account scope is empty.
  return `${authPrincipal}\u001F${accountScope ?? ''}`;
}

/** Canonical payload hash used for idempotency equivalence (delegates to SDK). */
export function payloadHash(payload: unknown): string {
  return hashPayload(normalizeIdempotencyPayload(payload));
}

// ── Store factory ────────────────────────────────────────────────

type OwnedCheckResult = Exclude<IdempotencyCheckResult, { kind: 'miss' }> | {
  kind: 'miss';
  payloadHash: string;
  claimToken: string;
};

export type OwnedIdempotencyStore = Omit<IdempotencyStore, 'check' | 'save' | 'release' | 'saveTransientError'> & {
  check(params: Parameters<IdempotencyStore['check']>[0]): Promise<OwnedCheckResult>;
  save(params: Parameters<IdempotencyStore['save']>[0] & { claimToken: string }): Promise<void>;
  release(params: Parameters<IdempotencyStore['release']>[0] & { claimToken: string }): Promise<void>;
  saveTransientError?(params: Parameters<NonNullable<IdempotencyStore['saveTransientError']>>[0] & {
    claimToken: string;
  }): Promise<void>;
};

interface FencedIdempotencyBackend extends IdempotencyBackend {
  replaceIfPendingOwner?(
    scopedKey: string,
    owner: string,
    entry: Parameters<IdempotencyBackend['put']>[1],
    minimumLeaseExpiry: number,
  ): Promise<boolean>;
  deleteIfPendingOwner?(scopedKey: string, owner: string): Promise<boolean>;
}

const backendLockTails = new WeakMap<object, Map<string, Promise<void>>>();

async function withBackendKeyLock<T>(backend: object, key: string, fn: () => Promise<T>): Promise<T> {
  let tails = backendLockTails.get(backend);
  if (!tails) {
    tails = new Map();
    backendLockTails.set(backend, tails);
  }
  const prior = tails.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const tail = prior.then(() => gate);
  tails.set(key, tail);
  await prior;
  try {
    return await fn();
  } finally {
    unlock();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

let storeInstance: OwnedIdempotencyStore | null = null;
let sdkStoreAdapter: IdempotencyStore | null = null;

interface HashAwareIdempotencyStoreConfig {
  backend: FencedIdempotencyBackend;
  ttlSeconds?: number;
  clockSkewSeconds?: number;
}

/**
 * Build an SDK-compatible store whose atomic claim records the request's real
 * hash. The SDK store currently claims with a payload-independent sentinel,
 * which cannot distinguish a concurrent retry from same-key reuse with a
 * different payload until the first request has completed.
 */
export function createHashAwareIdempotencyStore(
  config: HashAwareIdempotencyStoreConfig,
): OwnedIdempotencyStore {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createHashAwareIdempotencyStore requires a configuration object.');
  }
  if (!config.backend) {
    throw new TypeError('createHashAwareIdempotencyStore requires an idempotency backend.');
  }
  const ttlSeconds = validateTtl(config.ttlSeconds ?? REPLAY_TTL_SECONDS);
  const clockSkewSeconds = config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const { backend } = config;

  const scopedKey = (principal: string, key: string, extraScope?: string): string =>
    extraScope
      ? `${principal}${SCOPE_SEPARATOR}${extraScope}${SCOPE_SEPARATOR}${key}`
      : `${principal}${SCOPE_SEPARATOR}${key}`;

  const retryAfterSeconds = (expiresAt: number, nowSeconds: number): number =>
    Math.max(1, Math.min(IN_FLIGHT_RETRY_HINT_CAP_SECONDS, expiresAt - nowSeconds));

  const pendingOwner = (response: unknown): string | undefined => (
    response !== null
    && typeof response === 'object'
    && !Array.isArray(response)
    && typeof (response as Record<string, unknown>)[PENDING_OWNER_FIELD] === 'string'
      ? (response as Record<string, string>)[PENDING_OWNER_FIELD]
      : undefined
  );

  const isPending = (response: unknown): boolean => response === null || pendingOwner(response) !== undefined;

  const retryableRequestHash = (payloadHash: string): string | undefined => {
    if (!payloadHash.startsWith(RETRYABLE_HASH_PREFIX)) return undefined;
    const requestHash = payloadHash.slice(RETRYABLE_HASH_PREFIX.length);
    return /^[0-9a-f]{64}$/.test(requestHash) ? requestHash : undefined;
  };

  const classify = (
    entry: Awaited<ReturnType<IdempotencyBackend['get']>>,
    expectedHash: string,
  ): Exclude<IdempotencyCheckResult, { kind: 'miss' }> | null => {
    if (!entry) return null;
    const nowSeconds = Math.floor(Date.now() / 1e3);
    const releasedPayloadHash = retryableRequestHash(entry.payloadHash);
    if (releasedPayloadHash !== undefined) {
      if (entry.expiresAt + clockSkewSeconds < nowSeconds) return { kind: 'expired' };
      return releasedPayloadHash === expectedHash ? null : { kind: 'conflict' };
    }
    if (entry.expiresAt + clockSkewSeconds < nowSeconds) {
      return isPending(entry.response) ? null : { kind: 'expired' };
    }
    if (entry.payloadHash !== expectedHash) {
      return { kind: 'conflict' };
    }
    // AdCP handler responses are non-null objects, so null is an explicit
    // pending marker that both SDK backends can persist atomically.
    if (isPending(entry.response)) {
      return {
        kind: 'in-flight',
        retryAfterSeconds: retryAfterSeconds(entry.expiresAt, nowSeconds),
      };
    }
    return { kind: 'replay', response: entry.response };
  };

  const checkAndClaim = async (
    principal: string,
    key: string,
    payload: unknown,
    extraScope?: string,
  ): Promise<OwnedCheckResult> => {
    const cacheKey = scopedKey(principal, key, extraScope);
    const expectedHash = hashPayload(payload);
    const cachedEntry = await backend.get(cacheKey);
    const cached = classify(cachedEntry, expectedHash);
    if (cached) return cached;

    const expiresAt = Math.floor(Date.now() / 1e3) + IN_FLIGHT_TTL_SECONDS;
    const owner = randomUUID();
    const claimEntry = {
      payloadHash: expectedHash,
      response: { [PENDING_OWNER_FIELD]: owner },
      expiresAt,
      retainUntil: expiresAt + clockSkewSeconds,
    };
    const nowSeconds = Math.floor(Date.now() / 1e3);
    const releasedPayloadHash = cachedEntry
      ? retryableRequestHash(cachedEntry.payloadHash)
      : undefined;
    const expiredPending = cachedEntry
      && isPending(cachedEntry.response)
      && cachedEntry.expiresAt + clockSkewSeconds < nowSeconds;
    const claimed = releasedPayloadHash !== undefined
      ? await backend.replaceIfPayloadHash(cacheKey, cachedEntry!.payloadHash, claimEntry)
      : expiredPending
        ? await backend.replaceIfPayloadHashAndExpired(cacheKey, cachedEntry.payloadHash, claimEntry)
        : await backend.putIfAbsent(cacheKey, claimEntry);
    if (claimed) return { kind: 'miss', payloadHash: expectedHash, claimToken: owner };

    const rechecked = classify(await backend.get(cacheKey), expectedHash);
    return rechecked ?? { kind: 'in-flight', retryAfterSeconds: 1 };
  };

  return {
    ttlSeconds,
    check({ principal, key, payload, extraScope }) {
      const cacheKey = scopedKey(principal, key, extraScope);
      const operation = () => checkAndClaim(principal, key, payload, extraScope);
      return backend.replaceIfPendingOwner && backend.deleteIfPendingOwner
        ? operation()
        : withBackendKeyLock(backend, cacheKey, operation);
    },
    async renew({ principal, key, extraScope, claimToken }) {
      const cacheKey = scopedKey(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1e3) + IN_FLIGHT_TTL_SECONDS;
      const renewed = await renewOwnedClaim(cacheKey, claimToken, backend, pendingOwner, {
        payloadHash: '',
        response: { [PENDING_OWNER_FIELD]: claimToken },
        expiresAt,
        retainUntil: expiresAt + clockSkewSeconds,
      });
      if (!renewed) throw new Error('Idempotency claim ownership was lost before its lease could be renewed.');
    },
    async save({ principal, key, payloadHash, response, extraScope, claimToken }) {
      const cacheKey = scopedKey(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1e3) + ttlSeconds;
      const saved = await replaceOwnedClaim(cacheKey, claimToken, backend, pendingOwner, {
        payloadHash,
        response,
        expiresAt,
        retainUntil: expiresAt + clockSkewSeconds,
      });
      if (!saved) throw new Error('Idempotency claim ownership was lost before the response could be published.');
    },
    async release({ principal, key, extraScope, claimToken }) {
      const cacheKey = scopedKey(principal, key, extraScope);
      const released = await markOwnedClaimRetryable(
        cacheKey,
        claimToken,
        backend,
        pendingOwner,
        ttlSeconds,
        clockSkewSeconds,
      );
      if (!released) throw new Error('Idempotency claim ownership was lost before it could be released.');
    },
    async saveTransientError({ principal, key, payloadHash, response, extraScope, claimToken }) {
      const cacheKey = scopedKey(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1e3) + TRANSIENT_ERROR_TTL_SECONDS;
      const saved = await replaceOwnedClaim(cacheKey, claimToken, backend, pendingOwner, {
        payloadHash,
        response,
        expiresAt,
        retainUntil: expiresAt + clockSkewSeconds,
      });
      if (!saved) throw new Error('Idempotency claim ownership was lost before the response could be published.');
    },
    async probe() {
      if (backend.probe) await backend.probe();
    },
    capability() {
      return { replay_ttl_seconds: ttlSeconds };
    },
    async close() {
      if (backend.close) await backend.close();
    },
    ...(backend.clearAll
      ? {
          async clearAll() {
            await backend.clearAll!();
          },
        }
      : {}),
  };
}

async function renewOwnedClaim(
  cacheKey: string,
  owner: string,
  backend: FencedIdempotencyBackend,
  pendingOwner: (response: unknown) => string | undefined,
  entry: Parameters<IdempotencyBackend['put']>[1],
): Promise<boolean> {
  const current = await backend.get(cacheKey);
  if (!current || pendingOwner(current.response) !== owner) return false;
  const renewedEntry = { ...entry, payloadHash: current.payloadHash };
  if (backend.replaceIfPendingOwner) {
    return backend.replaceIfPendingOwner(
      cacheKey,
      owner,
      renewedEntry,
      Math.floor(Date.now() / 1e3) - 1,
    );
  }
  return withBackendKeyLock(backend, cacheKey, async () => {
    const lockedCurrent = await backend.get(cacheKey);
    if (!lockedCurrent || pendingOwner(lockedCurrent.response) !== owner) return false;
    await backend.put(cacheKey, { ...entry, payloadHash: lockedCurrent.payloadHash });
    return true;
  });
}

async function replaceOwnedClaim(
  cacheKey: string,
  owner: string,
  backend: FencedIdempotencyBackend,
  pendingOwner: (response: unknown) => string | undefined,
  entry: Parameters<IdempotencyBackend['put']>[1],
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const minimumLeaseExpiry = nowSeconds + CLAIM_SAVE_SAFETY_SECONDS;
  if (backend.replaceIfPendingOwner) {
    return backend.replaceIfPendingOwner(cacheKey, owner, entry, minimumLeaseExpiry);
  }
  return withBackendKeyLock(backend, cacheKey, async () => {
    const current = await backend.get(cacheKey);
    if (!current || pendingOwner(current.response) !== owner || current.expiresAt <= minimumLeaseExpiry) {
      return false;
    }
    await backend.put(cacheKey, entry);
    return true;
  });
}

async function markOwnedClaimRetryable(
  cacheKey: string,
  owner: string,
  backend: FencedIdempotencyBackend,
  pendingOwner: (response: unknown) => string | undefined,
  ttlSeconds: number,
  clockSkewSeconds: number,
): Promise<boolean> {
  const current = await backend.get(cacheKey);
  if (!current || pendingOwner(current.response) !== owner) return false;
  const expiresAt = Math.floor(Date.now() / 1e3) + ttlSeconds;
  const releasedEntry = {
    payloadHash: `${RETRYABLE_HASH_PREFIX}${current.payloadHash}`,
    response: null,
    expiresAt,
    retainUntil: expiresAt + clockSkewSeconds,
  };
  if (backend.replaceIfPendingOwner) {
    return backend.replaceIfPendingOwner(cacheKey, owner, releasedEntry, 0);
  }
  return withBackendKeyLock(backend, cacheKey, async () => {
    const lockedCurrent = await backend.get(cacheKey);
    if (!lockedCurrent || pendingOwner(lockedCurrent.response) !== owner) return false;
    await backend.put(cacheKey, {
      ...releasedEntry,
      payloadHash: `${RETRYABLE_HASH_PREFIX}${lockedCurrent.payloadHash}`,
    });
    return true;
  });
}

function validateTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    throw new Error(`createIdempotencyStore: ttlSeconds must be a finite integer. Got ${seconds}.`);
  }
  if (seconds < MIN_TTL_SECONDS) {
    throw new Error(
      `createIdempotencyStore: ttlSeconds must be >= ${MIN_TTL_SECONDS} `
      + `(1 hour per AdCP spec). Got ${seconds} — did you mean minutes?`,
    );
  }
  if (seconds > MAX_TTL_SECONDS) {
    throw new Error(
      `createIdempotencyStore: ttlSeconds must be <= ${MAX_TTL_SECONDS} `
      + `(7 days per AdCP spec). Got ${seconds}.`,
    );
  }
  return seconds;
}

function fencedPgBackend(): FencedIdempotencyBackend {
  const db = getPool();
  const base = pgBackend(db);
  return {
    ...base,
    async replaceIfPendingOwner(cacheKey, owner, entry, minimumLeaseExpiry) {
      const result = await db.query(
        `UPDATE adcp_idempotency
         SET payload_hash = $3,
             response = $4::jsonb,
             expires_at = TO_TIMESTAMP($5),
             retain_until = TO_TIMESTAMP($6)
         WHERE scoped_key = $1
           AND response ->> '__adcp_pending_owner' = $2
           AND expires_at > TO_TIMESTAMP($7)`,
        [cacheKey, owner, entry.payloadHash, JSON.stringify(entry.response), entry.expiresAt, entry.retainUntil, minimumLeaseExpiry],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async deleteIfPendingOwner(cacheKey, owner) {
      const result = await db.query(
        `DELETE FROM adcp_idempotency
         WHERE scoped_key = $1
           AND response ->> '__adcp_pending_owner' = $2`,
        [cacheKey, owner],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function getIdempotencyStore(): OwnedIdempotencyStore {
  if (storeInstance) return storeInstance;
  const backend = isDatabaseInitialized()
    ? fencedPgBackend()
    : memoryBackend();
  const base = createHashAwareIdempotencyStore({ backend, ttlSeconds: REPLAY_TTL_SECONDS });
  storeInstance = {
    ...base,
    check: params => base.check({ ...params, payload: normalizeIdempotencyPayload(params.payload) }),
  };
  return storeInstance;
}

/** Expose the token-aware store through the SDK beta.7 idempotency contract. */
export function adaptOwnedIdempotencyStoreForSdk(owned: OwnedIdempotencyStore): IdempotencyStore {
  return owned;
}

export function getSdkIdempotencyStore(): IdempotencyStore {
  if (sdkStoreAdapter) return sdkStoreAdapter;
  sdkStoreAdapter = adaptOwnedIdempotencyStoreForSdk(getIdempotencyStore());
  return sdkStoreAdapter;
}

function normalizeIdempotencyPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.packages) || typeof record.start_time !== 'string') return payload;
  const parsed = new Date(record.start_time);
  if (Number.isNaN(parsed.getTime())) return payload;
  return {
    ...record,
    // The storyboard runner advances stale sample flights to "tomorrow" at
    // request-build time. Replays built milliseconds later can differ only by
    // clock jitter, which should not turn the replay branch into a conflict.
    start_time: parsed.toISOString().slice(0, 10),
  };
}

/** Reset the store — tests only. Safe to call when no store has been created. */
export async function clearIdempotencyCache(): Promise<void> {
  const current = storeInstance;
  storeInstance = null;
  sdkStoreAdapter = null;
  if (current) await current.close();
}

export type { IdempotencyCheckResult };

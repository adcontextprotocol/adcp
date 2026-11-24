/**
 * Per-caller simulated market for an inventory tenant: the engine's state,
 * the media buys the tenant has built from its bookings, and the caller's
 * creative library.
 *
 * One market per caller and tenant. Every account the caller holds books
 * into the same market, so the caller's own buys compete for inventory.
 * State lives beside the caller's sandbox document in the training agent's
 * session store, and every read catches the market up to the caller's
 * sandbox clock (`account-sandbox.ts`), so a day only runs once the clock
 * has passed it.
 *
 * A request reads the whole session and writes it back when it ends, so two
 * concurrent requests from one caller would each write back the copy they
 * read, and the later write would undo the earlier one: a canceled booking
 * would come back and keep its flight sold. `withCallerMarkets` runs one
 * market request per caller at a time and persists it before the next one
 * reads.
 */
import { createHash } from 'node:crypto';
import { AdcpError } from '@adcp/sdk/server';
import { loadSandbox, sandboxNowMs, sandboxSessionKey } from '../account-sandbox.js';
import { getIdempotencyStore } from '../idempotency.js';
import { evictSessionFromRequestCache, flushDirtySessions } from '../state.js';
import { ENGINE_VERSION, InventorySimulation, type SeasonSeed, type SimulationState } from './engine/index.js';
import type { AssignmentRecord, CreativeRecord } from './creatives.js';
import { engineProducts, type SeededCatalog } from './seeded-products.js';
import { seasonFingerprint } from './season-file.js';

const MARKET_DOC_PREFIX = 'inventory_market\u001f';
const MARKET_LOCK_PRINCIPAL = 'inventory-market-mutex';
const MARKET_LOCK_WAIT_MS = 10_000;

export interface PackageRecord {
  /** Also the engine booking id. */
  package_id: string;
  product_id: string;
  pricing_option_id: string;
  budget: number;
  impressions?: number;
  bid_price?: number;
  installment_ids?: string[];
  countries?: string[];
  start_time: string;
  end_time: string;
  paused: boolean;
  canceled: boolean;
  /** Creatives from the caller's library that this package serves. */
  creative_assignments?: AssignmentRecord[];
  /** The buyer's opaque package correlation data, echoed unchanged. */
  context?: Record<string, unknown>;
}

export interface MediaBuyRecord {
  media_buy_id: string;
  account_id: string;
  name?: string;
  currency: string;
  start_time: string;
  end_time: string;
  confirmed_at: string;
  updated_at: string;
  revision: number;
  paused: boolean;
  canceled: boolean;
  packages: PackageRecord[];
  /** The buyer's opaque media-buy correlation data from create_media_buy,
   * echoed unchanged on reads. */
  context?: Record<string, unknown>;
}

export interface MarketDocument extends Record<string, unknown> {
  seed_id: string;
  /** The fingerprint of the season the market was built on (`seasonFingerprint`). */
  season_fingerprint: string;
  /** The engine version that built the market (`ENGINE_VERSION`). */
  engine_version: string;
  sim: SimulationState;
  media_buys: MediaBuyRecord[];
  next_id: number;
  /** The caller's creative library (`creatives.ts`), absent until it syncs one. */
  creatives?: CreativeRecord[];
  /** Products and pricing options the caller seeded with the test
   * controller (`seeded-products.ts`), absent until it seeds one. */
  seeded?: SeededCatalog;
}

export interface OpenMarket {
  sim: InventorySimulation;
  doc: MarketDocument;
  nowMs: number;
  nowIso: string;
  /** A fresh id for a media buy or package. */
  nextId(prefix: string): string;
  save(): void;
}

function marketKey(tenantId: string, principal: string | undefined): string {
  return `${MARKET_DOC_PREFIX}${tenantId}\u001f${principal && principal.length > 0 ? principal : 'anonymous'}`;
}

/**
 * Whether a stored market still belongs to the caller's timeline. One whose
 * seed id, season fingerprint or engine version changed (a stored document
 * without a fingerprint or an engine version counts as changed), or that has
 * run days the clock has not reached (the clock was unpinned by a
 * `reset_state` on any tenant, and reads the wall clock again), is discarded
 * and started fresh.
 */
function isCurrent(stored: MarketDocument | undefined, seed: SeasonSeed, nowMs: number): stored is MarketDocument {
  if (!stored || stored.seed_id !== seed.seed_id) return false;
  if (stored.season_fingerprint !== seasonFingerprint(seed)) return false;
  if (stored.engine_version !== ENGINE_VERSION) return false;
  return stored.sim.processed_through_day <= new InventorySimulation(seed, stored.sim, engineProducts(seed, stored.seeded)).today(nowMs);
}

/** Open the caller's market on a tenant, caught up to the caller's sandbox
 * clock. */
export async function openMarket(tenantId: string, seed: SeasonSeed, principal: string | undefined): Promise<OpenMarket> {
  const sandbox = await loadSandbox(principal);
  const nowMs = sandboxNowMs(sandbox.doc);
  const key = marketKey(tenantId, principal);
  const stored = sandbox.session.principalConfigurations.get(key) as MarketDocument | undefined;
  const doc: MarketDocument = isCurrent(stored, seed, nowMs)
    ? structuredClone(stored)
    : { seed_id: seed.seed_id, season_fingerprint: seasonFingerprint(seed), engine_version: ENGINE_VERSION, sim: InventorySimulation.create(seed, nowMs).state, media_buys: [], next_id: 1 };
  const sim = new InventorySimulation(seed, doc.sim, engineProducts(seed, doc.seeded));
  sim.advanceTo(nowMs);
  return {
    sim,
    doc,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    nextId(prefix: string) {
      const id = `${prefix}_${String(doc.next_id).padStart(4, '0')}`;
      doc.next_id += 1;
      return id;
    },
    save() {
      sandbox.session.principalConfigurations.set(key, structuredClone(doc));
    },
  };
}

/** Catch the caller's market up to its sandbox clock and persist it, after
 * the clock moves. Returns the days that ran. */
export async function advanceMarket(tenantId: string, seed: SeasonSeed, principal: string | undefined): Promise<number> {
  const sandbox = await loadSandbox(principal);
  const key = marketKey(tenantId, principal);
  const stored = sandbox.session.principalConfigurations.get(key) as MarketDocument | undefined;
  if (!isCurrent(stored, seed, sandboxNowMs(sandbox.doc))) return 0;
  const doc = structuredClone(stored);
  const ran = new InventorySimulation(seed, doc.sim, engineProducts(seed, doc.seeded)).advanceTo(sandboxNowMs(sandbox.doc));
  if (ran.length > 0) sandbox.session.principalConfigurations.set(key, doc);
  return ran.length;
}

/** Discard the caller's market on a tenant. */
export async function resetMarket(tenantId: string, principal: string | undefined): Promise<void> {
  const sandbox = await loadSandbox(principal);
  sandbox.session.principalConfigurations.delete(marketKey(tenantId, principal));
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` as the caller's only market request, on every tenant, and persist
 * what it wrote before the next one starts. An in-process queue orders this
 * machine's requests; a claim in the shared idempotency store orders them
 * across machines. Not reentrant: `fn` must not call it again.
 */
export async function withCallerMarkets<T>(principal: string | undefined, fn: () => Promise<T>): Promise<T> {
  const sessionKey = sandboxSessionKey(principal);
  const previous = queues.get(sessionKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withMarketClaim(sessionKey, fn));
  const tail = run.catch(() => undefined);
  queues.set(sessionKey, tail);
  try {
    return await run;
  } finally {
    if (queues.get(sessionKey) === tail) queues.delete(sessionKey);
  }
}

async function withMarketClaim<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const hash = createHash('sha256').update(sessionKey).digest('hex');
  const key = `inventory-market:${hash}`;
  const store = getIdempotencyStore();
  const deadline = Date.now() + MARKET_LOCK_WAIT_MS;
  let backoff = 10;
  let claim = await store.check({ principal: MARKET_LOCK_PRINCIPAL, key, payload: { session: hash } });
  while (claim.kind !== 'miss' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 250);
    claim = await store.check({ principal: MARKET_LOCK_PRINCIPAL, key, payload: { session: hash } });
  }
  if (claim.kind !== 'miss') {
    throw new AdcpError('CONFLICT', { recovery: 'transient', message: 'Another request is updating this sandbox market. Retry shortly.' });
  }
  try {
    // Read what the previous holder persisted, not this request's cached copy.
    evictSessionFromRequestCache(sessionKey);
    const result = await fn();
    await flushDirtySessions();
    return result;
  } finally {
    await store.release({ principal: MARKET_LOCK_PRINCIPAL, key, claimToken: claim.claimToken });
  }
}

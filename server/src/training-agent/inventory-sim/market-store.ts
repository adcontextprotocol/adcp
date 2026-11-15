/**
 * Per-caller simulated market for an inventory tenant: the engine's state,
 * plus the media buys the tenant has built from its bookings.
 *
 * One market per caller and tenant. Every account the caller holds books
 * into the same market, so the caller's own buys compete for inventory.
 * State lives beside the caller's sandbox document in the training agent's
 * session store, and every read catches the market up to the caller's
 * sandbox clock (`account-sandbox.ts`), so a day only runs once the clock
 * has passed it.
 */
import { loadSandbox, sandboxNowMs } from '../account-sandbox.js';
import { InventorySimulation, type SeasonSeed, type SimulationState } from './engine/index.js';

const MARKET_DOC_PREFIX = 'inventory_market\u001f';

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
}

export interface MarketDocument extends Record<string, unknown> {
  seed_id: string;
  sim: SimulationState;
  media_buys: MediaBuyRecord[];
  next_id: number;
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
 * Open the caller's market on a tenant, caught up to the caller's sandbox
 * clock. A market whose seed changed is discarded and started fresh.
 */
export async function openMarket(tenantId: string, seed: SeasonSeed, principal: string | undefined): Promise<OpenMarket> {
  const sandbox = await loadSandbox(principal);
  const nowMs = sandboxNowMs(sandbox.doc);
  const key = marketKey(tenantId, principal);
  const stored = sandbox.session.principalConfigurations.get(key) as MarketDocument | undefined;
  const doc: MarketDocument = stored && stored.seed_id === seed.seed_id
    ? structuredClone(stored)
    : { seed_id: seed.seed_id, sim: InventorySimulation.create(seed, nowMs).state, media_buys: [], next_id: 1 };
  const sim = new InventorySimulation(seed, doc.sim);
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
  if (!stored || stored.seed_id !== seed.seed_id) return 0;
  const doc = structuredClone(stored);
  const ran = new InventorySimulation(seed, doc.sim).advanceTo(sandboxNowMs(sandbox.doc));
  if (ran.length > 0) sandbox.session.principalConfigurations.set(key, doc);
  return ran.length;
}

/** Discard the caller's market on a tenant. */
export async function resetMarket(tenantId: string, principal: string | undefined): Promise<void> {
  const sandbox = await loadSandbox(principal);
  sandbox.session.principalConfigurations.delete(marketKey(tenantId, principal));
}

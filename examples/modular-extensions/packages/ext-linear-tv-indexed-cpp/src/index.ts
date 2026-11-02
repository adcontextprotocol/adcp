/* Generated from https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp@sha256:52f80ee6d7a35c6a803f3967c13ab7005d60d1857993437e608caab0ddde2bd1 (v1.5.0). Do not edit. */
import type { DemographicSystem, ExtensionEntry, MediaChannel } from '@adcp/core';

export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp" as const;
export const EXTENSION_DIGEST = "sha256:52f80ee6d7a35c6a803f3967c13ab7005d60d1857993437e608caab0ddde2bd1" as const;
export const EXTENSION_VERSION = "1.5.0" as const;
export const EXTENSION = { name: "linear-tv-indexed-cpp", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);

/** Branch id of pricing_model branch `indexed_cpp`: the discriminator value (no digest). */
export const INDEXED_CPP = "https://extensions.adcontextprotocol.org/linear-tv-indexed-cpp#indexed_cpp" as const;

/** pricing_model branch `indexed_cpp` on a host object (must-understand). */
export type LinearTvIndexedCppIndexedCppBranch = {
  pricing_model: typeof INDEXED_CPP;
  extension_model: Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
    uri: typeof EXTENSION_URI;
    digest: typeof EXTENSION_DIGEST;
    data: IndexedCPP;
  };
};

/** Runtime binding: this branch's data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readIndexedCpp(on: { pricing_model?: string; extension_model?: ExtensionEntry | null } | null | undefined): IndexedCPP | undefined {
  const t = on?.pricing_model === INDEXED_CPP ? on.extension_model : undefined;
  return t && t.uri === EXTENSION_URI && t.digest === EXTENSION_DIGEST ? (t.data as IndexedCPP) : undefined;
}

/** Runtime binding: build the branch's discriminator and body (seller side). */
export function indexedCppBranch(data: IndexedCPP): LinearTvIndexedCppIndexedCppBranch {
  return { pricing_model: INDEXED_CPP, extension_model: { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data } };
}

/** media_buy_state.extensions_state[] entry (must_understand: optional). */
export type LinearTvIndexedCppMediaBuyStateEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: IndexFixings;
};

/** Runtime binding: this extension's media_buy_state data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readMediaBuyState(on: { extensions_state?: ExtensionEntry[] | null } | null | undefined): IndexFixings | undefined {
  const t = on?.extensions_state?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as IndexFixings) : undefined;
}

/** Runtime binding: build a media_buy_state entry for this extension (seller side). */
export function mediaBuyStateEntry(data: IndexFixings): LinearTvIndexedCppMediaBuyStateEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}

/** capabilities: this extension's fragment in a declaration (must_understand: optional). */
export function readCapabilities(on: { uri: string; digest: string; capabilities?: object } | null | undefined): IndexedCPPCapabilities | undefined {
  return on && on.uri === EXTENSION_URI && on.digest === EXTENSION_DIGEST ? (on.capabilities as IndexedCPPCapabilities | undefined) : undefined;
}

/** Type-check this extension's capabilities fragment (seller side); pass it to server.declare(module, { capabilities }). */
export function capabilitiesFragment(data: IndexedCPPCapabilities): IndexedCPPCapabilities {
  return data;
}


/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "Index".
 */
export interface BookingIndex {
  dimension: string;
  factor: number;
  name: string;
  value: string;
}
/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "IndexFixing".
 */
export interface IndexFixing {
  change_id?: string;
  fixed_at: string;
  market_index: number;
  purchase_index: number;
  /**
   * The fixed rate per rating point that delivered points are invoiced at.
   */
  rate: number;
  revision: number;
}
/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "IndexFixings".
 */
export interface IndexFixings {
  /**
   * @minItems 1
   */
  fixings: [IndexFixing, ...IndexFixing[]];
}
/**
 * Rate per rating point = base_price x each index in order x the market index, rounded after each step as rounding says. The market index is unknown at booking: it is fixed by the seller at market_index.fixed_at, between floor and cap. ceiling_price is the rate at the cap, so the buyer knows the most it pays per point.
 *
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "IndexedCpp".
 */
export interface IndexedCPP {
  audience: {
    demographic: string;
    demographic_system: DemographicSystem;
  };
  /**
   * Price per rating point before any index (Ster: basisjaarprijs).
   */
  base_price: number;
  /**
   * The rate at market_index.cap: the most the buyer pays per point.
   */
  ceiling_price: number;
  /**
   * Indices fixed at booking, applied in order.
   *
   * @maxItems 32
   */
  indices: BookingIndex[];
  market_index: MarketIndex;
  rounding: IndexedCPPRounding;
  settlement: {
    invoice: "delivered_points_x_fixed_rate";
    /**
     * The audience currency whose delivered rating points are invoiced.
     */
    points_source: DemographicSystem;
  };
}
/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "MarketIndex".
 */
export interface MarketIndex {
  /**
   * The fixed index does not exceed this (Ster early requests: 100, so 1.0).
   */
  cap: number;
  /**
   * When the seller fixes the index (Ster: the day after the request deadline).
   */
  fixed_at: string;
  floor?: number;
}
/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "Rounding".
 */
export interface IndexedCPPRounding {
  decimals: number;
  mode: "half_away_from_zero" | "half_even";
}
/**
 * This interface was referenced by `LinearTvIndexedCppTypes`'s JSON-Schema
 * via the `definition` "IndexedCppCapabilities".
 */
export interface IndexedCPPCapabilities {
  /**
   * @minItems 1
   */
  channels: [MediaChannel, ...MediaChannel[]];
  /**
   * @minItems 1
   */
  points_sources: [DemographicSystem, ...DemographicSystem[]];
}

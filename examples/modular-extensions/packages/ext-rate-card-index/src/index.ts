/* Generated from https://extensions.adcontextprotocol.org/rate-card-index@sha256:a24ab2ac5282278300002b0fd40b8f2bd625f8197ef6fc4130e06fb417d4d580 (v1.5.0). Do not edit. */
import type { ExtensionEntry, FormatOptionReference } from '@adcp/core';

export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/rate-card-index" as const;
export const EXTENSION_DIGEST = "sha256:a24ab2ac5282278300002b0fd40b8f2bd625f8197ef6fc4130e06fb417d4d580" as const;
export const EXTENSION_VERSION = "1.5.0" as const;
export const EXTENSION = { name: "rate-card-index", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);

/** pricing_option.extensions[] entry (must_understand: optional). */
export type RateCardIndexPricingOptionEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: RateCard;
};

/** Runtime binding: this extension's pricing_option data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readPricingOption(on: { extensions?: ExtensionEntry[] | null } | null | undefined): RateCard | undefined {
  const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as RateCard) : undefined;
}

/** Runtime binding: build a pricing_option entry for this extension (seller side). */
export function pricingOptionEntry(data: RateCard): RateCardIndexPricingOptionEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}

/** commercial_terms.extensions[] entry (must_understand: required). */
export type RateCardIndexCommercialTermsEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: RateCardBinding;
};

/** Runtime binding: this extension's commercial_terms data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readCommercialTerms(on: { extensions?: ExtensionEntry[] | null } | null | undefined): RateCardBinding | undefined {
  const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as RateCardBinding) : undefined;
}

/** Runtime binding: build a commercial_terms entry for this extension (seller side). */
export function commercialTermsEntry(data: RateCardBinding): RateCardIndexCommercialTermsEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}


/**
 * Open vocabulary. Well-known values: always, format_option, placement, month, spot_length, buying_option, position, market, audience, geo. Vendor dimensions are namespaced (acmetv:daypart). A dimension the evaluator does not know makes the card non-evaluable locally; the seller's quote still binds (versioning.mdx:64-65).
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "Dimension".
 */
export type Dimension = string;
/**
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "RateCardRow".
 */
export type RateCardRow = IndexRow | IndexPointsRow | PremiumRow;

/**
 * Adds points/100 to the factor of the fired index row on target_dimension (Ster: preferred position +30 points on the buying option index).
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "IndexPointsRow".
 */
export interface IndexPointsRow {
  dimension: Dimension;
  /**
   * For dimension format_option: fires when the selection carries this core format option reference.
   */
  format_option_ref?: FormatOptionReference;
  kind: "index_points";
  name: string;
  points: number;
  target_dimension: Dimension;
  /**
   * Inclusive, compared with selection.start_time.
   */
  valid_from?: string;
  /**
   * Exclusive.
   */
  valid_until?: string;
  /**
   * Fires when the selection's value for dimension equals this. Absent for dimension always.
   */
  value?: string;
}
/**
 * Multiplies the running price. First applicable row per dimension fires.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "IndexRow".
 */
export interface IndexRow {
  /**
   * provisional only: the fixed factor does not exceed this.
   */
  cap?: number;
  dimension: Dimension;
  factor?: number;
  /**
   * provisional only: when the seller fixes the factor.
   */
  fixed_at?: string;
  /**
   * For dimension format_option: fires when the selection carries this core format option reference.
   */
  format_option_ref?: FormatOptionReference;
  kind: "index";
  name: string;
  /**
   * provisional: the factor is fixed after booking (Ster market index). The evaluator uses cap, so the result is a ceiling.
   */
  status?: "final" | "provisional";
  /**
   * Inclusive, compared with selection.start_time.
   */
  valid_from?: string;
  /**
   * Exclusive.
   */
  valid_until?: string;
  /**
   * Fires when the selection's value for dimension equals this. Absent for dimension always.
   */
  value?: string;
}
/**
 * Adds (fee) or subtracts (discount) a rate of the premium basis, or a fixed amount. Premiums do not compound with each other.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "PremiumRow".
 */
export interface PremiumRow {
  amount?: number;
  dimension: Dimension;
  /**
   * For dimension format_option: fires when the selection carries this core format option reference.
   */
  format_option_ref?: FormatOptionReference;
  kind: "fee" | "discount";
  name: string;
  rate?: number;
  /**
   * Inclusive, compared with selection.start_time.
   */
  valid_from?: string;
  /**
   * Exclusive.
   */
  valid_until?: string;
  /**
   * Fires when the selection's value for dimension equals this. Absent for dimension always.
   */
  value?: string;
}
/**
 * Price per pricing unit = base_price, times each fired index row in row order, then plus each fired premium. The parent pricing option's currency and pricing_model apply. quoted_selection is the selection the parent fixed_price quotes, so a buyer can reproduce fixed_price and price_breakdown.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "RateCard".
 */
export interface RateCard {
  /**
   * Price before any row (Ster: basisjaarprijs).
   */
  base_price: number;
  /**
   * What a premium rate applies to. adcp#7955 hard-codes indexed; GAM and most EU digital cards use base (rate-card market survey).
   */
  premium_basis?: "indexed" | "base";
  quoted_selection?: RateCardSelection;
  rounding: RateCardRounding;
  /**
   * @minItems 1
   * @maxItems 500
   */
  rows: [RateCardRow, ...RateCardRow[]];
}
/**
 * Selected value per dimension, plus the flight start used for row windows.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "Selection".
 */
export interface RateCardSelection {
  format_option_ref?: FormatOptionReference;
  start_time?: string;
  /**
   * Dimension name to selected value, e.g. {"month": "2027-03", "spot_length": "20s"}.
   */
  values: {
    [k: string]: string;
  };
}
/**
 * Seller-declared rounding. Ster rounds intermediate results to whole euros (rate-card market survey), which a fixed 4-decimal rule cannot reproduce.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "Rounding".
 */
export interface RateCardRounding {
  decimals: number;
  mode: "half_away_from_zero" | "half_even";
  step: "each_row" | "final";
}
/**
 * The card signed for one purchase, and the selection it was priced at.
 *
 * This interface was referenced by `RateCardIndexTypes`'s JSON-Schema
 * via the `definition` "RateCardBinding".
 */
export interface RateCardBinding {
  /**
   * Position in commercial_terms.purchases.
   */
  purchase_index: number;
  rate_card: RateCard;
  selection: RateCardSelection;
}

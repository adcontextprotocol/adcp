/* Generated from https://extensions.adcontextprotocol.org/seller-adjustable-terms@sha256:856330354341524a6b3246e48527cca92b27d2eedeb474305da60dbc64f20b66 (v1.0.0). Do not edit. */
import type { Duration, ExtensionEntry } from '../../../../../../../packages/core/src/index.ts';

export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/seller-adjustable-terms" as const;
export const EXTENSION_DIGEST = "sha256:856330354341524a6b3246e48527cca92b27d2eedeb474305da60dbc64f20b66" as const;
export const EXTENSION_VERSION = "1.0.0" as const;
export const EXTENSION = { name: "seller-adjustable-terms", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);

/** commercial_terms.extensions[] entry (must_understand: required). */
export type SellerAdjustableTermsCommercialTermsEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: SellerAdjustableTerms;
};

/** Runtime binding: this extension's commercial_terms data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readCommercialTerms(on: { extensions?: ExtensionEntry[] | null } | null | undefined): SellerAdjustableTerms | undefined {
  const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as SellerAdjustableTerms) : undefined;
}

/** Runtime binding: build a commercial_terms entry for this extension (seller side). */
export function commercialTermsEntry(data: SellerAdjustableTerms): SellerAdjustableTermsCommercialTermsEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}


/**
 * Tagged on kind. A later kind is another variant under another digest; a buyer pinned to an earlier digest never sees a variant it cannot read.
 *
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "Constraint".
 */
export type AllowanceConstraint = DecreaseConstraint | TimeShiftConstraint | AlternatesConstraint;

/**
 * Port of adcp#8102 seller-adjustable-term.json. A change that satisfies constraint and min_notice creates a media buy revision with no offer; anything else needs a seller offer. Never changes a unit price and never raises what the buyer pays.
 *
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "Allowance".
 */
export interface SellerAdjustmentAllowance {
  allowance_id: string;
  constraint: AllowanceConstraint;
  min_notice?: Duration;
  /**
   * RFC 6901 pointer into the purchase. No array indexes.
   */
  path: string;
  purchase_index: number;
}
/**
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "DecreaseConstraint".
 */
export interface DecreaseConstraint {
  kind: "decrease";
  max_change_fraction?: number;
  /**
   * The value after the change MUST NOT be lower.
   */
  min?: number;
}
/**
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "TimeShiftConstraint".
 */
export interface TimeShiftConstraint {
  /**
   * Absent means either.
   */
  direction?: "earlier" | "later";
  kind: "time_shift";
  max_shift: Duration;
}
/**
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "AlternatesConstraint".
 */
export interface AlternatesConstraint {
  /**
   * @minItems 1
   */
  alternates: [
    {
      label?: string;
      /**
       * A complete replacement value, with the same schema as the field at path.
       */
      value: {
        [k: string]: unknown;
      };
    },
    ...{
      label?: string;
      /**
       * A complete replacement value, with the same schema as the field at path.
       */
      value: {
        [k: string]: unknown;
      };
    }[]
  ];
  kind: "alternates";
}
/**
 * Port of adcp#8102 applied-seller-adjustment.json. One application advances the media buy revision; the matching account change record (account.change_recorded) carries change_id.
 *
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "AppliedAdjustment".
 */
export interface AppliedAdjustment {
  adjustment_id: string;
  allowance_id: string;
  applied_at: string;
  /**
   * The account change feed record for this revision.
   */
  change_id?: string;
  path: string;
  previous_value:
    | number
    | string
    | boolean
    | {
        [k: string]: unknown;
      }
    | unknown[]
    | null;
  purchase_index: number;
  reason: string;
  /**
   * The media buy revision this application created.
   */
  revision: number;
  value:
    | number
    | string
    | boolean
    | {
        [k: string]: unknown;
      }
    | unknown[]
    | null;
}
/**
 * Readback of changes the seller applied under this buy's accepted allowances, oldest first.
 *
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "AppliedAdjustments".
 */
export interface AppliedAdjustments {
  /**
   * @minItems 1
   */
  applied: [AppliedAdjustment, ...AppliedAdjustment[]];
}
/**
 * This interface was referenced by `SellerAdjustableTermsTypes`'s JSON-Schema
 * via the `definition` "SellerAdjustableTerms".
 */
export interface SellerAdjustableTerms {
  /**
   * Unique by allowance_id, ordered by allowance_id (stable terms_digest).
   *
   * @minItems 1
   */
  allowances: [SellerAdjustmentAllowance, ...SellerAdjustmentAllowance[]];
}

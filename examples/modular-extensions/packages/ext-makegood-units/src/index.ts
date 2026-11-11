/* Generated from https://extensions.adcontextprotocol.org/makegood-units@sha256:0debf79a73907c27500528c005c03948e3256a1128e2e74b25d58c7b6ac93bd4 (v1.5.0). Do not edit. */
import type { ContextObject, ContributedTask, Duration, ExtensionEntry, TaskStatus } from '@adcp/core';

export const EXTENSION_URI = "https://extensions.adcontextprotocol.org/makegood-units" as const;
export const EXTENSION_DIGEST = "sha256:0debf79a73907c27500528c005c03948e3256a1128e2e74b25d58c7b6ac93bd4" as const;
export const EXTENSION_VERSION = "1.5.0" as const;
export const EXTENSION = { name: "makegood-units", uri: EXTENSION_URI, digest: EXTENSION_DIGEST, version: EXTENSION_VERSION } as const;
/** Package root (bundle, lock, semantic checks). A generated layer loads it through adcp.lock.json; a runtime plug-in passes this namespace to createAdcpClient({ extensions }) or server.declare(). */
export const EXTENSION_MODULE_DIR = new URL('..', import.meta.url);

/** commercial_terms.extensions[] entry (must_understand: required). */
export type MakegoodUnitsCommercialTermsEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: MakegoodTerms;
};

/** Runtime binding: this extension's commercial_terms data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readCommercialTerms(on: { extensions?: ExtensionEntry[] | null } | null | undefined): MakegoodTerms | undefined {
  const t = on?.extensions?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as MakegoodTerms) : undefined;
}

/** Runtime binding: build a commercial_terms entry for this extension (seller side). */
export function commercialTermsEntry(data: MakegoodTerms): MakegoodUnitsCommercialTermsEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}

/** media_buy_state.extensions_state[] entry (must_understand: optional). */
export type MakegoodUnitsMediaBuyStateEntry = Omit<ExtensionEntry, 'uri' | 'digest' | 'data'> & {
  uri: typeof EXTENSION_URI;
  digest: typeof EXTENSION_DIGEST;
  data: MakegoodLedger;
};

/** Runtime binding: this extension's media_buy_state data, typed, or undefined. Matches this exact uri@digest only. (An app's generated layer has it as a plain attribute.) */
export function readMediaBuyState(on: { extensions_state?: ExtensionEntry[] | null } | null | undefined): MakegoodLedger | undefined {
  const t = on?.extensions_state?.find((x) => x.uri === EXTENSION_URI && x.digest === EXTENSION_DIGEST);
  return t ? (t.data as MakegoodLedger) : undefined;
}

/** Runtime binding: build a media_buy_state entry for this extension (seller side). */
export function mediaBuyStateEntry(data: MakegoodLedger): MakegoodUnitsMediaBuyStateEntry {
  return { uri: EXTENSION_URI, digest: EXTENSION_DIGEST, data };
}

/** Task id of `request_makegood`: a branch of the task union (no digest). Seller capabilities map a transport name to it. */
export const REQUEST_MAKEGOOD = "https://extensions.adcontextprotocol.org/makegood-units#request_makegood" as const;

/**
 * Tasks this extension contributes. An app's generated layer turns each into a typed client method
 * (client.<task>(request)) and a typed handler (server.handle('<task>', handler)). Runtime binding:
 * client.ext(module).<task>(request) and server.handle(module.tasks.<task>, handler).
 */
export const tasks = {
  /** The buyer asks the seller to issue a make-good unit under an accepted rule for a missed deliverable. The seller answers accepted, with the zero-cost package that carries the unit, or rejected, with a reason. */
  requestMakegood: {
    id: REQUEST_MAKEGOOD,
    uri: EXTENSION_URI,
    digest: EXTENSION_DIGEST,
    branch: "request_makegood",
    request: "MakegoodRequest",
    response: "MakegoodResponse",
  } as ContributedTask<MakegoodRequest, MakegoodResponse>,
};

/**
 * Response of request_makegood: accepted, with the zero-cost package that carries the unit, or rejected, with a reason.
 *
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodResponse".
 */
export type MakegoodResponse = MakegoodAccepted | MakegoodRejected;

/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "IssuedMakegood".
 */
export interface IssuedMakegood {
  /**
   * The account change feed record for that revision.
   */
  change_id?: string;
  /**
   * For each keep_same attribute: the value on the replaced purchase and on the unit.
   */
  evidence: {
    [k: string]: {
      makegood: string;
      original: string;
    };
  };
  issued_at: string;
  makegood_id: string;
  /**
   * The zero-cost core package that carries the unit.
   */
  package_id: string;
  reason: "deliverable_missed" | "under_delivery";
  /**
   * The media buy revision that added the unit.
   */
  revision: number;
  rule_id: string;
}
/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodAccepted".
 */
export interface MakegoodAccepted {
  /**
   * The account change feed record for that revision.
   */
  change_id: string;
  context?: ContextObject;
  makegood_id: string;
  outcome: "accepted";
  /**
   * The zero-cost core package that carries the unit.
   */
  package_id: string;
  /**
   * The media buy revision that added the unit.
   */
  revision: number;
  rule_id: string;
  status: TaskStatus;
}
/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodLedger".
 */
export interface MakegoodLedger {
  /**
   * @minItems 1
   */
  issued: [IssuedMakegood, ...IssuedMakegood[]];
}
/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodRejected".
 */
export interface MakegoodRejected {
  context?: ContextObject;
  outcome: "rejected";
  rejection: {
    /**
     * RULE_NOT_ACCEPTED: the rule is not in the accepted terms, or does not cover the named package. CAP_EXCEEDED: the rule's max_units are used up.
     */
    code: "RULE_NOT_ACCEPTED" | "CAP_EXCEEDED";
    message: string;
  };
  rule_id: string;
  status: TaskStatus;
}
/**
 * Arguments of request_makegood: the buyer asks the seller to issue a make-good unit under an accepted rule for a deliverable that was missed or under-delivered.
 *
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodRequest".
 */
export interface MakegoodRequest {
  context?: ContextObject;
  /**
   * Repeating a request with the same key returns the first response.
   */
  idempotency_key: string;
  media_buy_id: string;
  /**
   * The package of the missed or short deliverable: the package of the rule's purchase.
   */
  package_id: string;
  reason: "deliverable_missed" | "under_delivery";
  /**
   * The accepted make-good rule the request invokes.
   */
  rule_id: string;
}
/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodRule".
 */
export interface MakegoodRule {
  /**
   * Units are zero-cost core packages (budget 0). Always true; a paid replacement is an offer.
   */
  at_no_cost: true;
  /**
   * Attributes the unit must share with the purchase it replaces.
   */
  keep_same: ("product" | "creator" | "platform" | "format" | "show" | "daypart" | "market")[];
  /**
   * Most make-good units the seller may add under this rule over the life of the buy.
   */
  max_units: number;
  /**
   * The purchase whose missed or short delivery this rule makes good.
   */
  purchase_index: number;
  rule_id: string;
  trigger: "deliverable_missed" | "under_delivery";
  /**
   * A unit must start no later than this long after the purchase's accepted end_time.
   */
  window: Duration;
}
/**
 * This interface was referenced by `MakegoodUnitsTypes`'s JSON-Schema
 * via the `definition` "MakegoodTerms".
 */
export interface MakegoodTerms {
  /**
   * Unique by rule_id, ordered by rule_id (stable terms_digest).
   *
   * @minItems 1
   */
  rules: [MakegoodRule, ...MakegoodRule[]];
}

/**
 * Pure consistency checks for the AAO agent resolver.
 *
 * Implements the verifier algorithm from `specs/capabilities-brand-url.md`:
 *
 * - Step 3: eTLD+1 origin binding (agent URL host vs brand_url host),
 *   with `authorized_operators[]` opt-in for the SaaS-platform-as-operator
 *   case.
 * - Step 5: agents[]-membership lookup (byte-equal `url`, multi-match
 *   detection).
 * - Step 6: jwks_uri resolution with `/.well-known/jwks.json` origin
 *   default.
 * - Step 7: identity.key_origins consistency check, with the round-2 carve
 *   out for purposes whose JWKS came from a publisher pin.
 * - The required-when rule from §"Compliance impact": when a signing
 *   posture is declared, `identity.key_origins.{purpose}` MUST be present
 *   for the relevant purpose.
 *
 * All functions are pure — no fetching, no I/O. The orchestrator wires
 * them together. Pure code is what the table-driven unit tests exercise.
 */
import type { BrandAgentEntry, ParsedBrandJson } from "./brand-json-fetcher.js";
import { etldPlusOne } from "./safe-fetch-strict.js";
import { AgentResolverError } from "./errors.js";

export type OriginBinding = "etld1_match" | "authorized_operator" | "mismatch";

export interface OriginBindingResult {
  binding: OriginBinding;
  agent_etld1: string;
  brand_url_etld1: string;
}

export function checkOriginBinding(
  agentUrl: string,
  brandUrl: string,
  authorizedOperators: ParsedBrandJson["authorized_operators"],
): OriginBindingResult {
  const a = etldPlusOne(new URL(agentUrl).hostname);
  const b = etldPlusOne(new URL(brandUrl).hostname);
  if (a === b) {
    return { binding: "etld1_match", agent_etld1: a, brand_url_etld1: b };
  }
  for (const op of authorizedOperators) {
    if (op.domain.toLowerCase() === a) {
      return { binding: "authorized_operator", agent_etld1: a, brand_url_etld1: b };
    }
  }
  return { binding: "mismatch", agent_etld1: a, brand_url_etld1: b };
}

export interface AgentLookupResult {
  matches: BrandAgentEntry[];
}

/**
 * Find brand_json `agents[]` entries whose `url` byte-equals `agentUrl`.
 * Per spec step 5: byte-for-byte, no canonicalization. Multiple matches is
 * an ambiguity error — surfaced by the caller, not here.
 */
export function findAgentEntries(
  agentUrl: string,
  brandJson: ParsedBrandJson,
): AgentLookupResult {
  const matches = brandJson.agents.filter((a) => a.url === agentUrl);
  return { matches };
}

/**
 * Resolve `jwks_uri` from a matched brand_json agent entry. Defaults to
 * `/.well-known/jwks.json` at the agent URL's origin when absent.
 */
export function resolveJwksUri(agentEntry: BrandAgentEntry, agentUrl: string): string {
  if (agentEntry.jwks_uri && agentEntry.jwks_uri.length > 0) {
    return agentEntry.jwks_uri;
  }
  const u = new URL(agentUrl);
  return `${u.origin}/.well-known/jwks.json`;
}

/**
 * Extract the `identity` block from a capabilities response. Returns null
 * when the block is absent or non-object.
 */
export function extractIdentity(
  capabilities: Record<string, unknown>,
): { key_origins?: Record<string, string>; per_principal_key_isolation?: boolean } | null {
  const identity = capabilities.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const obj = identity as Record<string, unknown>;
  const ko = obj.key_origins;
  const out: { key_origins?: Record<string, string>; per_principal_key_isolation?: boolean } = {};
  if (typeof obj.per_principal_key_isolation === "boolean") {
    out.per_principal_key_isolation = obj.per_principal_key_isolation;
  }
  if (ko && typeof ko === "object" && !Array.isArray(ko)) {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(ko as Record<string, unknown>)) {
      if (typeof v === "string") filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0) out.key_origins = filtered;
  }
  return out;
}

/**
 * Determine which signing purposes have a non-trivial declaration that
 * triggers the §"Required-when" rule. Returns a set of purposes (e.g.
 * `request_signing`, `webhook_signing`) for which `key_origins.{purpose}`
 * MUST be present.
 *
 * Per round-2 spec:
 * - `request_signing`: triggered by non-empty `supported_for` OR `required_for`
 *   (NOT by `supported: true` with empty arrays).
 * - `webhook_signing`: triggered by `supported === true`.
 *
 * `governance_signing` and `tmp_signing` are not surface-mandatory in 3.x
 * — the spec leaves them advisory until 4.0.
 */
export function declaredSigningPurposes(
  capabilities: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  const reqSigning = capabilities.request_signing;
  if (reqSigning && typeof reqSigning === "object" && !Array.isArray(reqSigning)) {
    const r = reqSigning as Record<string, unknown>;
    const requiredFor = Array.isArray(r.required_for) ? r.required_for : [];
    const supportedFor = Array.isArray(r.supported_for) ? r.supported_for : [];
    if (requiredFor.length > 0 || supportedFor.length > 0) {
      out.add("request_signing");
    }
  }
  const webhookSigning = capabilities.webhook_signing;
  if (webhookSigning && typeof webhookSigning === "object" && !Array.isArray(webhookSigning)) {
    const w = webhookSigning as Record<string, unknown>;
    if (w.supported === true) {
      out.add("webhook_signing");
    }
  }
  return out;
}

export interface KeyOriginCheckOptions {
  /** Purposes whose JWKS came from a publisher pin and so should bypass
   * the consistency check entirely. Empty by default. */
  bypassedPurposes?: Set<string>;
}

export interface KeyOriginIssue {
  purpose: string;
  expected_origin: string;
  actual_origin: string;
}

export interface KeyOriginCheckResult {
  /** Whether all declared purposes' origins matched (or were bypassed). */
  match: boolean;
  /** Purposes for which a match was attempted (i.e. capabilities declared
   * `key_origins.{purpose}` AND the purpose was not bypassed). */
  checkedPurposes: string[];
  /** Any mismatches surfaced. */
  issues: KeyOriginIssue[];
}

/**
 * Verify that `identity.key_origins.{purpose}` matches the resolved
 * `jwks_uri` host for every declared purpose, skipping bypassed purposes.
 *
 * `keyOrigins` is the map from capabilities. `resolvedJwksUri` is the URL
 * we actually fetched. The comparison is on origin (`scheme://host`), not
 * on path — `key_origins` is documented as "scheme + host".
 */
export function checkKeyOrigins(
  keyOrigins: Record<string, string> | undefined,
  resolvedJwksUri: string,
  options: KeyOriginCheckOptions = {},
): KeyOriginCheckResult {
  const bypass = options.bypassedPurposes ?? new Set<string>();
  if (!keyOrigins) {
    return { match: true, checkedPurposes: [], issues: [] };
  }
  const actualOrigin = new URL(resolvedJwksUri).origin;
  const issues: KeyOriginIssue[] = [];
  const checkedPurposes: string[] = [];
  for (const [purpose, declared] of Object.entries(keyOrigins)) {
    if (bypass.has(purpose)) continue;
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(declared).origin;
    } catch {
      issues.push({
        purpose,
        expected_origin: declared,
        actual_origin: actualOrigin,
      });
      checkedPurposes.push(purpose);
      continue;
    }
    checkedPurposes.push(purpose);
    if (expectedOrigin !== actualOrigin) {
      issues.push({
        purpose,
        expected_origin: expectedOrigin,
        actual_origin: actualOrigin,
      });
    }
  }
  return { match: issues.length === 0, checkedPurposes, issues };
}

/**
 * Apply the §"Required-when" rule. Returns the first missing purpose so the
 * caller can produce a `request_signature_key_origin_missing` error with
 * the right detail fields. Caller passes `keyOrigins` from capabilities.
 */
export function findMissingKeyOrigin(
  declaredPurposes: Set<string>,
  keyOrigins: Record<string, string> | undefined,
): { purpose: string; posture: string } | null {
  const ko = keyOrigins ?? {};
  for (const purpose of declaredPurposes) {
    if (!(purpose in ko)) {
      return { purpose, posture: "declared without key_origins" };
    }
  }
  return null;
}

/**
 * Convenience: throw the right `AgentResolverError` for a key-origin
 * mismatch detected by `checkKeyOrigins`. Pulls `purpose` and origin
 * fields from the first issue (the spec returns one mismatch per call).
 */
export function throwKeyOriginMismatch(issue: KeyOriginIssue): never {
  throw new AgentResolverError("request_signature_key_origin_mismatch", {
    purpose: issue.purpose,
    expected_origin: issue.expected_origin,
    actual_origin: issue.actual_origin,
  });
}

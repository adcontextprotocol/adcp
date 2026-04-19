/**
 * Idempotency middleware for the training agent.
 *
 * Enforces AdCP's at-most-once semantics on mutating tool calls per
 * `docs/building/implementation/security.mdx` and the `idempotency.yaml`
 * compliance storyboard:
 *
 * - Same `(principal, idempotency_key)` + equivalent canonical payload →
 *   return the cached inner response with `replayed: true` on the envelope.
 * - Same key + different canonical payload → `IDEMPOTENCY_CONFLICT`.
 * - Key past TTL → `IDEMPOTENCY_EXPIRED`.
 * - Missing key on a mutating request → `INVALID_REQUEST`.
 *
 * Canonicalization is RFC 8785 JSON Canonicalization Scheme (JCS) via the
 * `canonicalize` package, hashed with SHA-256. Excluded from the hash:
 * `idempotency_key`, `context`, `governance_context`, and
 * `push_notification_config.authentication.credentials`.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import canonicalize from 'canonicalize';

export const REPLAY_TTL_SECONDS = 86400;
const REPLAY_TTL_MS = REPLAY_TTL_SECONDS * 1000;
// ±60s clock-skew tolerance per security.mdx rule 6.
const TTL_SKEW_MS = 60_000;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

const MAX_ENTRIES_PER_PRINCIPAL = 10_000;

/**
 * Tasks whose request schemas require `idempotency_key`.
 * Derived from static/schemas/source/**\/*-request.json — every schema whose
 * `required` list includes `idempotency_key` maps to the corresponding tool.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'create_media_buy',
  'update_media_buy',
  'sync_creatives',
  'build_creative',
  'activate_signal',
  'sync_accounts',
  'sync_governance',
  'sync_catalogs',
  'sync_event_sources',
  'log_event',
  'provide_performance_feedback',
  'sync_plans',
  'report_plan_outcome',
  'acquire_rights',
  'update_rights',
  'creative_approval',
  'create_property_list',
  'update_property_list',
  'delete_property_list',
  'create_collection_list',
  'update_collection_list',
  'delete_collection_list',
  'create_content_standards',
  'update_content_standards',
  'calibrate_content',
  'report_usage',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

const EXCLUDED_FROM_HASH = new Set([
  'idempotency_key',
  'context',
  'governance_context',
]);

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
 *
 * The shape matches `sessionKeyFromArgs` conceptually: account_id wins
 * over brand.domain; both are already length/charset bounded upstream so
 * this layer just consumes whatever string it receives.
 */
export function scopedPrincipal(
  authPrincipal: string,
  accountScope: string | undefined,
): string {
  // `\u001F` (unit separator) keeps auth principals that contain `:` (like
  // `workos:org_…`) unambiguous even when the account scope is empty.
  return `${authPrincipal}\u001F${accountScope ?? ''}`;
}

interface CacheEntry {
  requestHash: string;
  response: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const entriesPerPrincipal = new Map<string, number>();

function strippedForHash(payload: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (EXCLUDED_FROM_HASH.has(k)) continue;
    filtered[k] = v;
  }
  // Strip push_notification_config.authentication.credentials (may rotate)
  const pnc = filtered.push_notification_config as
    | { authentication?: { credentials?: unknown; [k: string]: unknown }; [k: string]: unknown }
    | undefined;
  if (pnc && typeof pnc === 'object' && pnc.authentication && typeof pnc.authentication === 'object') {
    const { credentials: _drop, ...rest } = pnc.authentication;
    filtered.push_notification_config = { ...pnc, authentication: rest };
  }
  return filtered;
}

export function payloadHash(payload: Record<string, unknown>): string {
  const filtered = strippedForHash(payload);
  const canonical = canonicalize(filtered);
  if (canonical === undefined) {
    // RFC 8785 inputs must be canonicalizable JSON. Unreachable for valid
    // schema-checked payloads; throw loudly so two non-canonicalizable
    // payloads can't silently hash-equal to the empty string.
    throw new Error('Cannot canonicalize payload for idempotency hash');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

function cacheKey(principal: string, idempotencyKey: string): string {
  return `${principal}\u0000${idempotencyKey}`;
}

export function validateKeyFormat(key: unknown): key is string {
  return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Constant-time comparison of two hex SHA-256 digests. The attacker-control
 * surface here is low — an attacker who sees a timing leak still needs to
 * iterate payloads, not hash prefixes — but the secure posture is cheap.
 */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export type IdempotencyOutcome =
  | { kind: 'miss' }
  | { kind: 'replay'; response: Record<string, unknown> }
  | { kind: 'conflict' }
  | { kind: 'expired' }
  | { kind: 'rate_limited' };

/**
 * Look up `(principal, key)` and classify the outcome.
 *
 * - `miss`: no prior entry — the caller should execute the handler and then
 *   call `cacheResponse(...)` on success.
 * - `replay`: exact canonical-payload match — return the stored response
 *   with `replayed: true` injected on the envelope.
 * - `conflict`: same key, different canonical payload, still within TTL —
 *   return `IDEMPOTENCY_CONFLICT`.
 * - `expired`: same key, past TTL (with ±60s skew) — return `IDEMPOTENCY_EXPIRED`.
 */
export function lookupIdempotency(
  principal: string,
  idempotencyKey: string,
  requestPayload: Record<string, unknown>,
  now: number = Date.now(),
): IdempotencyOutcome {
  const entry = cache.get(cacheKey(principal, idempotencyKey));
  if (!entry) return { kind: 'miss' };

  if (entry.expiresAt + TTL_SKEW_MS < now) {
    // Past TTL → return EXPIRED and evict so a fresh request with the same
    // key can eventually succeed once the buyer realises their error.
    cache.delete(cacheKey(principal, idempotencyKey));
    decrementPrincipalCount(principal);
    return { kind: 'expired' };
  }

  const incomingHash = payloadHash(requestPayload);
  if (!hashesEqual(incomingHash, entry.requestHash)) return { kind: 'conflict' };

  return { kind: 'replay', response: entry.response };
}

/**
 * Store a successful response so subsequent replays with the same key and
 * canonical payload return the same bytes. Only call this for successful
 * executions — errors must re-execute on retry (security.mdx rule 2 + 3).
 *
 * Returns `true` on insert, `false` when the per-principal cap blocked the
 * insert. Callers who cannot afford a silent-drop-into-re-execution on
 * retry SHOULD surface `RATE_LIMITED` when this returns `false`
 * (security.mdx rule 8).
 */
export function cacheResponse(
  principal: string,
  idempotencyKey: string,
  requestPayload: Record<string, unknown>,
  response: Record<string, unknown>,
  now: number = Date.now(),
): boolean {
  let used = entriesPerPrincipal.get(principal) ?? 0;
  if (used >= MAX_ENTRIES_PER_PRINCIPAL) {
    // Opportunistic eviction: sweep this principal's expired entries before
    // giving up. Avoids wedging a principal for 24h once they briefly burst
    // past the cap on stale keys.
    used = evictExpiredForPrincipal(principal, now);
    if (used >= MAX_ENTRIES_PER_PRINCIPAL) return false;
  }
  const requestHash = payloadHash(requestPayload);
  cache.set(cacheKey(principal, idempotencyKey), {
    requestHash,
    response,
    createdAt: now,
    expiresAt: now + REPLAY_TTL_MS,
  });
  entriesPerPrincipal.set(principal, used + 1);
  return true;
}

/** Check whether a fresh insert would succeed without actually inserting. */
export function isPrincipalAtCap(principal: string, now: number = Date.now()): boolean {
  const used = entriesPerPrincipal.get(principal) ?? 0;
  if (used < MAX_ENTRIES_PER_PRINCIPAL) return false;
  const after = evictExpiredForPrincipal(principal, now);
  return after >= MAX_ENTRIES_PER_PRINCIPAL;
}

function evictExpiredForPrincipal(principal: string, now: number): number {
  const prefix = `${principal}\u0000`;
  let count = entriesPerPrincipal.get(principal) ?? 0;
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue;
    if (entry.expiresAt + TTL_SKEW_MS < now) {
      cache.delete(key);
      count--;
    }
  }
  if (count <= 0) entriesPerPrincipal.delete(principal);
  else entriesPerPrincipal.set(principal, count);
  return Math.max(count, 0);
}

function decrementPrincipalCount(principal: string): void {
  const v = entriesPerPrincipal.get(principal) ?? 0;
  if (v <= 1) entriesPerPrincipal.delete(principal);
  else entriesPerPrincipal.set(principal, v - 1);
}

/** Clear the entire cache. Tests only. */
export function clearIdempotencyCache(): void {
  cache.clear();
  entriesPerPrincipal.clear();
}

/** Test-only introspection. */
export function _cacheSize(): number {
  return cache.size;
}

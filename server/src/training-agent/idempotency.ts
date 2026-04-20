/**
 * Idempotency wiring for the training agent.
 *
 * Thin facade over `@adcp/client/server`'s `createIdempotencyStore`, which
 * implements the spec behaviour (RFC 8785 JCS payload hash, atomic
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
  createIdempotencyStore,
  memoryBackend,
  pgBackend,
  hashPayload,
  type IdempotencyStore,
  type IdempotencyCheckResult,
} from '@adcp/client/server';
import { isDatabaseInitialized, getPool } from '../db/client.js';

export const REPLAY_TTL_SECONDS = 86400;

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
  'acquire_rights',
  'activate_signal',
  'build_creative',
  'calibrate_content',
  'create_collection_list',
  'create_content_standards',
  'create_media_buy',
  'create_property_list',
  'creative_approval',
  'delete_collection_list',
  'delete_property_list',
  'log_event',
  'provide_performance_feedback',
  'report_plan_outcome',
  'report_usage',
  'si_initiate_session',
  'si_send_message',
  'sync_accounts',
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
  return hashPayload(payload);
}

// ── Store factory ────────────────────────────────────────────────

let storeInstance: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (storeInstance) return storeInstance;
  const backend = isDatabaseInitialized()
    ? pgBackend(getPool())
    : memoryBackend();
  storeInstance = createIdempotencyStore({ backend, ttlSeconds: REPLAY_TTL_SECONDS });
  return storeInstance;
}

/** Reset the store — tests only. Safe to call when no store has been created. */
export async function clearIdempotencyCache(): Promise<void> {
  const current = storeInstance;
  storeInstance = null;
  if (current) await current.close();
}

export type { IdempotencyCheckResult };

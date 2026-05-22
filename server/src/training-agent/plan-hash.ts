/**
 * `plan_hash` — audit-layer cryptographic receipt that binds a signed
 * `governance_context` JWS to the exact plan state the governance agent
 * evaluated. Spec: docs/governance/campaign/specification.mdx
 * §"Plan binding and audit".
 *
 * Formula: `base64url_no_pad(SHA-256(JCS(plan_payload)))` where the preimage
 * is one element of the `plans[]` array from `sync_plans` with the closed
 * GA-bookkeeping exclusion list stripped. The list is closed — extending or
 * shrinking it is a profile version bump, same rule as the idempotency
 * payload-equivalence exclusion list.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';

/**
 * Closed exclusion list — fields the governance agent writes onto its
 * persisted plan-revision record that MUST be stripped before hashing.
 * None of these appear on the `sync_plans` request schema; they live only
 * on internal GA state. Spec rule: anything not on this list is IN the
 * preimage (fail-safe toward inclusion).
 */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'status',
  'syncedAt',
  'revisionHistory',
  'committedBudget',
  'committedByType',
]);

/** Strip the closed bookkeeping fields from a stored plan-revision object. */
export function stripBookkeeping<T extends Record<string, unknown>>(plan: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan)) {
    if (!BOOKKEEPING_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Compute `plan_hash` over a plan-revision object. Caller passes the plan
 * exactly as the governance agent persists it — bookkeeping fields included.
 * The function strips the closed exclusion list, JCS-canonicalizes, hashes
 * with SHA-256, and returns the unpadded base64url digest. Node's
 * `'base64url'` encoding is unpadded per the encoding spec.
 */
export function computePlanHash(plan: Record<string, unknown>): string {
  const preimage = stripBookkeeping(plan);
  const jcs = canonicalize(preimage);
  return createHash('sha256').update(jcs, 'utf8').digest().toString('base64url');
}

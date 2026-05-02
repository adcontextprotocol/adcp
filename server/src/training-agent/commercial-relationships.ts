/**
 * Per-buyer-agent commercial relationship lookup for the training agent.
 *
 * Maps an authenticated `principal` (set by the bearer authenticator in
 * `index.ts` from the bearer token) to the agent's onboarded commercial
 * state with this seller. Drives the `BILLING_NOT_PERMITTED_FOR_AGENT`
 * gate in `handleSyncAccounts` per the spec contract in
 * `error-details/billing-not-permitted-for-agent.json`.
 *
 * The training agent recognizes these demo-bearer prefixes (any token
 * matching the `demo-*` family that the index.ts authenticator accepts):
 *
 *   demo-billing-passthrough-*    → passthrough_only
 *     The agent has no payments relationship with the seller — only the
 *     operator can be invoiced. Submitting `billing: "agent"` or
 *     `billing: "advertiser"` rejects with BILLING_NOT_PERMITTED_FOR_AGENT
 *     and `error.details.suggested_billing: "operator"`.
 *
 *   demo-billing-agent-billable-* → agent_billable
 *     The agent has a payments relationship with the seller. Any
 *     supported `billing` value is permitted (no per-agent gate fires).
 *     Default-equivalent for any principal NOT matching one of the
 *     above prefixes — included as an explicit map entry for storyboard
 *     determinism (a runner that wants to assert "the agent-billable
 *     branch never rejects" gets a stable principal to target).
 *
 * Any principal not recognized here returns `undefined` — no per-agent
 * gate fires, so the seller falls through to the seller-wide capability
 * gate only. This matches the spec's bright-line rule for
 * BILLING_NOT_PERMITTED_FOR_AGENT: emit only when agent identity AND a
 * commercial-relationship record both exist; otherwise return
 * BILLING_NOT_SUPPORTED (the broader code) so the per-agent code does
 * not act as an onboarding oracle for callers without an established
 * record.
 */

export type CommercialRelationship = 'passthrough_only' | 'agent_billable';

// Bearer-token namespace shape — must stay in lockstep with the demo
// authenticator at server/src/training-agent/index.ts:85, which sets
// `principal: \`static:demo:${token}\`` for any bearer matching
// DEMO_TEST_KIT_KEY_PATTERN. If that authenticator's prefix changes,
// these constants stop matching and the per-agent gate silently no-ops
// (tests catch it, but the coupling is otherwise invisible).
const PASSTHROUGH_PREFIX = 'static:demo:demo-billing-passthrough-';
const AGENT_BILLABLE_PREFIX = 'static:demo:demo-billing-agent-billable-';

/**
 * Look up the calling buyer agent's commercial relationship with this
 * seller. Returns undefined for principals without an onboarded record —
 * the per-agent gate then falls through, preventing
 * BILLING_NOT_PERMITTED_FOR_AGENT from acting as an onboarding oracle
 * for unrecognized callers.
 *
 * `tenantId` is reserved for the v6 per-tenant platforms wiring (see
 * follow-up PR — accounts.upsert on v6 platforms). The legacy /mcp route
 * has no tenant scope, so callers there pass undefined. The parameter is
 * declared on the signature now so the v6 PR doesn't force a signature
 * break across every call site.
 */
export function getCommercialRelationship(
  principal: string | undefined,
  _tenantId?: string,
): CommercialRelationship | undefined {
  if (!principal) return undefined;
  if (principal.startsWith(PASSTHROUGH_PREFIX)) return 'passthrough_only';
  if (principal.startsWith(AGENT_BILLABLE_PREFIX)) return 'agent_billable';
  return undefined;
}

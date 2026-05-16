/**
 * Per-(operator, billing) commercial-relationship lookup for the
 * BILLING_NOT_SUPPORTED `scope: "account"` sub-gate. Distinct surface
 * from `commercial-relationships.ts` (which is keyed on the calling
 * buyer agent's principal — a per-CALLER dimension) — this lookup is
 * keyed on the OPERATOR + BILLING combo for THIS account.
 *
 * **Spec contract** (per `error-details/billing-not-supported.json`):
 *
 *   `BILLING_NOT_SUPPORTED` with `error.details.scope: "account"` —
 *   "the seller's capability accepts the value generally but not for
 *   the specific operator on this account."
 *
 * Real sellers maintain a per-(operator, brand) ledger of which
 * billing models they have onboarded. The training-agent simulates this
 * with a documented operator-domain convention so storyboards can
 * deterministically exercise the sub-gate without per-test setup.
 *
 * **Convention.** Operators whose domain ends in `-no-direct-billing.example`
 * are treated as having no direct billing relationship for `operator`
 * billing — the seller's capability accepts `operator` (in
 * `supported_billing`), but this specific operator can't be invoiced
 * directly. `agent` and `advertiser` billing remain unrestricted —
 * they don't depend on a per-account direct-billing relationship with
 * the operator. Real sellers would have richer per-(operator, brand,
 * billing) data; the training-agent ships the simplest convention that
 * exercises the sub-gate.
 *
 * **Scope discipline.** This sub-gate is per-account (operator-scoped),
 * NOT per-buyer-agent. It fires regardless of who's calling — even an
 * agent-billable buyer agent submitting `billing: operator` for a
 * no-direct-billing operator gets the same `scope: "account"` rejection.
 * That mirrors real-world data: the operator's billing eligibility is
 * a property of the seller's onboarding state with the operator, not
 * of the agent representing the buyer.
 *
 * **Phase 2 outlook.** When SDK Phase 2 ships framework-level
 * enforcement, both billing gates (`BILLING_NOT_PERMITTED_FOR_AGENT`
 * per-agent and `BILLING_NOT_SUPPORTED` `scope: "account"`
 * per-operator) become candidates for framework-side machinery
 * — the agent-side gate via `ctx.agent.billing_capabilities`, the
 * account-side via a parallel `ctx.account.billing_relationships`
 * surface that doesn't yet exist. Until then, both stay adopter-side
 * with the data sources colocated here and in
 * `commercial-relationships.ts`.
 */

const NO_DIRECT_BILLING_OPERATOR_SUFFIX = '-no-direct-billing.example';

/**
 * Returns true when the (operator, billing) combination is restricted
 * — the seller advertises the billing model in its capability but has
 * no direct billing relationship for this operator.
 *
 * Today the convention only applies to `billing: 'operator'`. The other
 * two billing models (`agent`, `advertiser`) don't depend on per-operator
 * onboarding state — `agent` billing routes through the buyer agent's
 * payments relationship; `advertiser` billing is direct to the
 * advertiser regardless of which operator placed the buy.
 */
export function isPerAccountBillingRestricted(
  operator: string,
  billing: string,
): boolean {
  if (billing !== 'operator') return false;
  return operator.endsWith(NO_DIRECT_BILLING_OPERATOR_SUFFIX);
}

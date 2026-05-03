---
---

feat(training-agent): implement BILLING_NOT_SUPPORTED `scope: "account"` sub-gate

Closes the third remaining billing-gate follow-up: per-(operator, billing) restriction tested end-to-end. Distinct from the seller-wide capability gate (already implemented) and the per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT`, also already implemented). Per the spec at [`error-details/billing-not-supported.json`](https://adcontextprotocol.org/schemas/v3/error-details/billing-not-supported.json):

> `BILLING_NOT_SUPPORTED` with `error.details.scope: "account"` — "the seller's capability accepts the value generally but not for the specific operator on this account."

**What landed:**

1. New `account-billing-relationships.ts` — single helper `isPerAccountBillingRestricted(operator, billing)` keyed on operator domain. Documents the convention: operators whose domain ends in `-no-direct-billing.example` have no direct billing relationship for `billing: 'operator'`. Other billing models (`agent`, `advertiser`) don't depend on per-operator onboarding state. Real sellers would have richer per-(operator, brand, billing) data; the training-agent ships the simplest convention that exercises the sub-gate deterministically.

2. `handleSyncAccounts` — new gate fires between the capability gate (`scope: "capability"`) and the per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT`). Returns `BILLING_NOT_SUPPORTED` with `error.details.scope: "account"` and the supported_billing echo.

3. **4 new unit tests** in `account-handlers.test.ts`:
   - operator with no-direct-billing suffix → `BILLING_NOT_SUPPORTED scope: "account"`.
   - same operator with `billing: agent` passes (gate is operator-billing-specific — scope discipline regression-pin).
   - operator without the suffix passes (over-broadening regression-pin).
   - composition: passthrough principal still gets per-agent rejection on `billing: agent` (gate-ordering regression-pin — account-scope gate doesn't apply because billing is `agent`, not `operator`).

**Scope discipline.** The per-account gate is operator-scoped, not per-buyer-agent. It fires regardless of who's calling — even an agent-billable buyer agent submitting `billing: operator` for a no-direct-billing operator gets the same `scope: "account"` rejection. That mirrors real-world data: the operator's billing eligibility is a property of the seller's onboarding state with the operator, not of the agent representing the buyer.

**Phase 2 outlook.** When SDK Phase 2 ships framework-level enforcement, both billing gates (`BILLING_NOT_PERMITTED_FOR_AGENT` per-agent and `BILLING_NOT_SUPPORTED scope: "account"` per-operator) become candidates for framework-side machinery — the agent-side gate via `ctx.agent.billing_capabilities` (already populated since #4026), the account-side via a parallel `ctx.account.billing_relationships` surface that doesn't yet exist. Until then, both stay adopter-side with the data sources colocated in `commercial-relationships.ts` (per-agent) and `account-billing-relationships.ts` (per-operator).

26/26 unit tests pass; full server suite clean (3159 passed, 42 skipped) excluding two pre-existing flaky tests (`illustration-c2pa-wiring`, `addie-router LLM confidence tiers`).

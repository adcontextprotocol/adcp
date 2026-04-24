---
"adcontextprotocol": minor
---

Single governance agent per account — reconcile 3.x governance schemas with a coherent semantic model (closes #3010).

**The inconsistency.** 3.x registration (`sync_governance`) allowed up to 10 governance agents per account with per-agent `categories`, and the campaign-governance spec documented fan-out-and-unanimous-approval. But the protocol envelope and `check_governance` carried a single `governance_context` string, and the four-value `scope` enum on brand.json (`spend_authority | delivery_monitor | brand_safety | regulatory_compliance`) didn't carve the governance responsibility at its joints — those aren't independent specialisms held by different authorities, they're phases and facets of one evaluation over one plan.

**Decision.** Commit to single-agent: an account binds to one governance agent that owns the full lifecycle. Multi-agent registration was aspirational and produced schema inconsistencies without a coherent semantic story. A plan is unitary (budget, policies, restricted attributes all live on the plan); `check_governance` already separates authorization / fidelity / drift on the `phase` axis (`purchase` / `modification` / `delivery`); internal specialist review (legal, brand safety, category) belongs inside the configured agent, not at the registration layer.

**Changes.**

- `account/sync-governance-request`: `governance_agents` constrained to `maxItems: 1`. `categories` field removed. Description makes the one-agent-per-account invariant explicit and explains why (phases, not specialisms; plan is unitary; specialist review composes inside the agent).
- `core/protocol-envelope`: `governance_context` stays a singular string. Description updated to state the single-agent invariant and why phased lifecycle (not split authority) means one token covers the full governed action.
- `brand.json`: remove the governance-agent `scope` enum (`spend_authority | delivery_monitor | brand_safety | regulatory_compliance`) — no longer meaningful under single-agent registration. P&G example updated to drop the stray `scope` array.
- `docs/governance/campaign/specification.mdx`: replace "Multi-agent composition" with "One governance agent per account" explaining the rationale (authorization/fidelity/drift are phases, regulatory rules are encoded in the plan, specialist review composes inside the agent, one lifecycle/one token/one audit trail). Fix the remaining `governance_agent(s)` plural residue.
- `governance/check-governance-request` / `response` / `report-plan-outcome-request`: revert any language implying per-agent fan-out; all three are single-agent calls as originally designed.
- `docs/governance/campaign/tasks/check_governance.mdx`, `report_plan_outcome.mdx`: revert to the single-agent prose.

**Backwards compatibility.** Buyers with one agent registered (practically every 3.0 deployment per maintainer's reading of the ecosystem) are unaffected. Buyers that registered more than one agent per account against the previous `maxItems: 10` — if any exist — MUST collapse to a single agent; the protocol does not support routing or aggregating across multiple. Sellers that validated the `categories` field MUST treat registrations without it as valid (the field is removed, not deprecated).

**What this is not.** This PR does not address specialist governance surfaces adjacent to campaign governance — brand-safety pre-screen of creatives, property-list policy, content-standards evaluation — those are separate governance domains with their own agents and their own lifecycle. Campaign governance speaks only for the plan.

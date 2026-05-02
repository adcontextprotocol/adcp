---
"adcontextprotocol": minor
---

spec(accounts): billing-gate conformance storyboard + BrandAuthorizationResolver naming guidance

Tier-3 follow-up to #3828 / #3831 (BuyerAgentRegistry spec backing).

**Conformance.** New universal storyboard `billing-gate-dispatch` under `static/compliance/source/universal/` exercises the two-gate dispatch contract on `sync_accounts.billing` rejection:

- Capability gate (`BILLING_NOT_SUPPORTED` with `error.details.scope: "capability"` and `error.details.supported_billing` echo). Skipped when the seller supports all three `billing` values.
- Per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT` with the clamped `error.details.rejected_billing` + optional `error.details.suggested_billing`). Skipped when the test kit does not declare `commercial_relationship: "passthrough_only"`. Recovery phase chains off the rejection and validates that retrying with the seller's `suggested_billing` produces a successful provisioning.

The storyboard also asserts the negative-shape security clamp on the per-agent gate: `error.details` MUST NOT carry `permitted_billing` (full subset), `rate_card`, `payment_terms`, `credit_limit`, or `billing_entity` — these are the per-agent commercial-state oracles that `error-details/billing-not-permitted-for-agent.json` (`additionalProperties: false`) closes off.

Conformance catalogs (`docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx`) updated; doc-parity lint clean.

The storyboard documents two follow-ups it does not yet land:

1. `comply_test_controller` `seed_buyer_agent` extension to toggle the test caller's `commercial_relationship` programmatically — would let any seller exercise both per-agent branches without a manually-curated test kit.
2. Test-kit field schema for `commercial_relationship` (currently referenced in `skip_if` expressions; needs a normative test-kit schema entry).

**SDK naming.** Adds normative guidance to `accounts-and-agents.mdx` Buyer-agent identity section: SDKs surfacing a typed Protocol for the brand-operator authorization check MUST name it after the file consulted — `BrandAuthorizationResolver` (or idiomatic equivalent), NOT `AdagentsResolver`. `adagents.json` is publisher-side and models a different relationship; naming the buyer-side resolver after it confuses surfaces and locks adopters into the wrong mental model. Cross-coordination filed as adcp-client-python#346 ahead of either SDK shipping the Protocol.

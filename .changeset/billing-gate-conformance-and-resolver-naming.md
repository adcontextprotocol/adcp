---
"adcontextprotocol": minor
---

spec(accounts): billing-gate conformance storyboard + BrandAuthorizationResolver naming guidance

Tier-3 follow-up to #3828 / #3831 (BuyerAgentRegistry spec backing). **Validated end-to-end against the training-agent reference implementation in #3851** — running the storyboard against a real agent surfaced three bugs that lint couldn't catch, all corrected before this PR went ready:

1. `check: error_code` doesn't accept a `path` parameter for per-account error extraction → switched to `check: field_value` with explicit path on both gate phases.
2. `expect_error: true` requires transport-level error markers (MCP `isError` / A2A `failed`) — sync_accounts produces transport-level success with per-account errors in the success envelope, not transport-layer failures → removed the flag from both gate phases with explanatory comment.
3. Idempotency-key reuse across reject/recover phases produced `IDEMPOTENCY_CONFLICT` (same key + different payload per error-handling.mdx) → recover phase now uses a fresh idempotency_key with a distinct stability tag, and both the narrative and recover-phase docs corrected to reflect that the recover phase is a new request rather than a replay.

Plus one runner-side gap documented in the test kit: today's storyboard runner does not auto-extract `auth.api_key` from the test kit; callers pass it explicitly via `--auth`. The kit's `auth.api_key` declares the bearer the seller's harness expects to be authenticated under; the CLI carries it onto the wire.

Storyboard now passes 3/3 strict assertions against the training-agent's per-agent-gate flow (capability_discovery + per_agent_gate_reject + per_agent_gate_recover); capability_gate phase grades `not_applicable` when the seller advertises all three billing values, which is the correct outcome against the training-agent.

**Conformance.** New universal storyboard `billing-gate-dispatch` under `static/compliance/source/universal/` exercises the two-gate dispatch contract on `sync_accounts.billing` rejection:

- Capability gate (`BILLING_NOT_SUPPORTED` with `error.details.scope: "capability"` and `error.details.supported_billing` echo). Skipped when the seller supports all three `billing` values.
- Per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT` with the clamped `error.details.rejected_billing` + optional `error.details.suggested_billing`). Skipped when the test kit does not declare `commercial_relationship: "passthrough_only"`. Recovery phase chains off the rejection and validates that retrying with the seller's `suggested_billing` produces a successful provisioning.

The storyboard also asserts the negative-shape security clamp on the per-agent gate: `error.details` MUST NOT carry `permitted_billing` (full subset), `rate_card`, `payment_terms`, `credit_limit`, or `billing_entity` — these are the per-agent commercial-state oracles that `error-details/billing-not-permitted-for-agent.json` (`additionalProperties: false`) closes off.

Conformance catalogs (`docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx`) updated; doc-parity lint clean.

The storyboard documents two follow-ups it does not yet land:

1. `comply_test_controller` `seed_buyer_agent` extension to toggle the test caller's `commercial_relationship` programmatically — would let any seller exercise both per-agent branches without a manually-curated test kit.
2. Test-kit field schema for `commercial_relationship` (currently referenced in `skip_if` expressions; needs a normative test-kit schema entry).

**SDK naming.** Adds normative guidance to `accounts-and-agents.mdx` Buyer-agent identity section: SDKs surfacing a typed Protocol for the brand-operator authorization check MUST name it after the file consulted — `BrandAuthorizationResolver` (or idiomatic equivalent), NOT `AdagentsResolver`. `adagents.json` is publisher-side and models a different relationship; naming the buyer-side resolver after it confuses surfaces and locks adopters into the wrong mental model. Cross-coordination filed as adcp-client-python#346 ahead of either SDK shipping the Protocol.

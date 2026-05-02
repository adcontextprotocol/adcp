---
"adcontextprotocol": minor
---

spec(accounts): buyer-agent identity model + billing error-code coverage for sync_accounts

Adds the spec/doc backing that adcp-client #1269 (BuyerAgentRegistry) needs to land without inventing wire behavior.

**Error codes (additive, non-breaking).** Registers four codes referenced by `sync_accounts` but missing from the canonical enum, plus one new code for the per-buyer-agent commercial gate:

- `BILLING_NOT_SUPPORTED` — seller-wide capability gate (`supported_billing` does not include the value), or per-account-relationship gate. Carries `error.details.scope` ∈ `{"capability", "account"}` so callers can dispatch without parsing prose. Default reject for billing-value mismatches.
- `BILLING_NOT_PERMITTED_FOR_AGENT` — *new*. Seller-wide capability accepts the value, but the calling buyer agent's commercial relationship does not (e.g., onboarded as passthrough-only — no payments relationship — so `agent` and `advertiser` reject). Distinct from `BILLING_NOT_SUPPORTED` so agents can dispatch on autonomous-retry vs surface-to-human. `error.details` MUST conform to the new `error-details/billing-not-permitted-for-agent.json` schema: `rejected_billing` plus an optional single `suggested_billing`. The shape is deliberately clamped — it MUST NOT carry the agent's full permitted-billing subset, rate cards, payment terms, credit limit, billing entity, or any other per-agent commercial state (those are commercial-state oracles; full-subset disclosure in a single probe is exactly what the clamp prevents).
- `PAYMENT_TERMS_NOT_SUPPORTED` — seller declines the requested `payment_terms` value.
- `BRAND_REQUIRED` — billable operation attempted without a brand reference.

All four registered in `enum`, `enumDescriptions`, and `enumMetadata` per the dual-surface requirement (#3738).

**Uniform-response rule for unauthenticated callers.** Sellers MUST NOT emit `BILLING_NOT_PERMITTED_FOR_AGENT` to unauthenticated, unverified, or weakly-authenticated callers — emitting the per-agent code without an established agent identity is a cross-tenant onboarding oracle (same shape as `*_NOT_FOUND`). Unauthenticated callers receive `BILLING_NOT_SUPPORTED` (the broader code) regardless of which gate would have fired with identity established. Documented in `error-handling.mdx` Billing and Account Setup section.

**`sync_accounts` task doc** adds the normative line that sellers MAY reject `billing` at the per-buyer-agent commercial gate distinct from the seller-wide capability gate; error rows cross-link to the new error-handling and accounts-and-agents sections. Also fixes a pre-existing doc bug: the error table referenced `PAYMENT_REQUIRED` (never registered in the enum) where the registered code is `ACCOUNT_PAYMENT_REQUIRED` — corrected to use the registered identifier.

**Buyer-agent identity narrative.** New "Buyer-agent identity" section in `accounts-and-agents.mdx` framing the two-layer model the spec already implies but doesn't name: agent identity (signed-request `agent_url` derivation OR seller's credential-to-agent mapping) and brand-operator authorization (`brand.json/authorized_operators`). Both layers MUST pass; the checks compose. The brand-operator check runs against cached `brand.json` per existing revocation/cache semantics (eventual revocation, 24h TTL), and high-value or first-time-on-brand provisioning SHOULD bypass the cache to close the TOCTOU window. Per-buyer-agent commercial state — onboarding records, payment-relationship status, default account terms — is offline (out of scope) but surfaces on the wire through (a) the new `BILLING_NOT_PERMITTED_FOR_AGENT` runtime gate and (b) defaults sellers MAY apply during `sync_accounts` upsert (per-account values on the request always take precedence). Defines "passthrough-only" inline on first use.

**`agent_url` derivation.** `security.mdx` "Agent identity" section now names the derivation explicitly: `agent_url` is the `url` field of the `agents[]` entry whose `jwks_uri` resolved the `keyid` at step 7 of the verifier checklist — not a JWK claim, JWS claim, or signed envelope field. The publication coordinate the verifier already used to fetch the JWKS *is* the canonical identity. Closes a loophole where an SDK could surface a buyer-asserted `agent_url` from the envelope and treat it as cryptographically established. The bearer / API-key / OAuth transport is also clarified: agent identity MUST come from the seller's credential-to-agent mapping; sellers MUST NOT introduce an envelope-side `buyer_agent_url` as an alternate input. Existing buyer-asserted *verifier* references (`creative.verify_agent.agent_url`, `governance.accepted_verifiers[].agent_url`) are explicitly outside this prohibition — they name agents the seller invokes under a published allowlist, not the signer.

**Two new `error-details/` schemas** lock the recovery shapes so SDKs and conformance fixtures don't diverge: `billing-not-permitted-for-agent.json` (`additionalProperties: false`, `rejected_billing` + optional `suggested_billing`) and `billing-not-supported.json` (`scope` + optional `supported_billing` echo). The per-agent schema's clamp prevents full-subset commercial-state disclosure; the per-supported schema's `scope` field MUST be omitted on the unauthenticated path so it cannot itself become a per-account-relationship oracle.

**Tier 3 (conformance fixtures + cross-language naming alignment with Python `BrandAuthorizationResolver`)** tracked as #3828.

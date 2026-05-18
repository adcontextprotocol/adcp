---
"adcontextprotocol": minor
---

Brand protocol gains `verify_brand_claim` — a unified brand-agent task that lets partners ask the brand authoritatively whether a specific claim about its identity is true. One tool, four claim types discriminated by `claim_type`:

- `subsidiary` — "Is this brand a subsidiary of yours?" (house-side)
- `parent` — "Is this brand your parent house?" (leaf-side mirror, lets mutual assertion complete at the agent layer)
- `property` — "Is this site / app / property one of yours?"
- `trademark` — "Is this trademark yours?"

The shared `VerificationStatus` enum (`owned`, `pending_review`, `transferring`, `disputed`, `not_ours`, `licensed_in`, `licensed_out`, `unknown`) captures the rich state surface crawl-based mutual-assertion can't express. Per-claim-type `details` field carries the typed response payload. Public/authorized tier split mirrors `get_brand_identity`.

**Trust model is asymmetric by direction.** Signed rejections (`disputed` / `not_ours`) win unilaterally — a brand has standing to refuse association without reciprocation. Signed assertions (`owned` / `pending_review` / `transferring` / `licensed_*`) do NOT bypass mutual assertion — the reciprocating side must still confirm. When both sides have brand-agents, mutual assertion completes via two signed agent calls (subsidiary + parent claim types) without requiring a static-file crawl. Closes the malicious-house scenario: a brand can't unilaterally claim subsidiaries it doesn't own.

**Cross-protocol Conformance addition to `brand.json`:** when a house publishes a brand-agent advertising `verify_brand_claim` with the relevant claim type, consumers SHOULD prefer the agent's signed response over crawl-based inference. The crawl path remains the fallback when the agent is unreachable or returns `unknown`. The email-notification SHOULD from PR #4505 continues to apply for houses without a brand-agent.

**Schema additions:**
- `brand/verification-status.json` — shared status enum
- `brand/verify-brand-claim-request.json` — schema-level `discriminator: { propertyName: "claim_type" }` with four per-claim-type variants
- `brand/verify-brand-claim-response.json` — `claim_type` echoed, `status` from the shared enum, per-claim-type `details` object

**No changes to `brand.json` itself.** Additive — every existing publisher and every existing brand-agent continues to work unchanged. The single-tool design preserves AdCP's tool-count economy: new claim types (e.g., licensed_from, endorsement) are payload-discriminator additions, not new tools.

Standing licensed relationships as a static brand.json publishing surface (parallel to `brand_refs[]` for ownership) remain out of scope and are tracked as a separate design alongside the rights-protocol team. `verify_brand_claim` exposes the licensed states via the brand-agent's internal records; the static-file substrate that backs them is a future RFC.

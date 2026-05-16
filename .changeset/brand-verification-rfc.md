---
---

Draft RFC for the brand verification surface — one unified brand-agent task that lets partners ask the brand authoritatively whether a specific claim about its identity is true.

The RFC lives at `docs/brand-protocol/proposals/brand-verification-rfc.mdx`. Tracks the federated trust capability discussed in [#4521](https://github.com/adcontextprotocol/adcp/issues/4521) and supersedes the email-based self-healing path landed in PR #4505. Not yet normative — needs spec-owner sign-off before any agent implementations standardize.

New task proposed: **`verify_brand_claim`** — one tool, four claim types discriminated by `claim_type`:

- `subsidiary` — "Is this brand a subsidiary of yours?" (house-side)
- `parent` — "Is this brand your parent house?" (leaf-side mirror, lets mutual assertion complete at the agent layer)
- `property` — "Is this site / app / property one of yours?"
- `trademark` — "Is this trademark yours?"

Shared `VerificationStatus` enum (`owned`, `pending_review`, `transferring`, `disputed`, `not_ours`, `licensed_in`, `licensed_out`, `unknown`) captures the rich state surface crawl cannot express. Per-claim-type `details` field carries the typed response payload. Public/authorized tier split mirrors `get_brand_identity`.

Trust model is asymmetric by direction: signed rejections (`disputed` / `not_ours`) win unilaterally — a brand can refuse association without reciprocation. Signed assertions (`owned` / `pending_review` / `transferring` / `licensed_*`) do NOT bypass mutual assertion — the reciprocating side must still confirm. When both sides have brand-agents, mutual assertion completes via two signed agent calls (subsidiary + parent claim types) without requiring a static-file crawl.

Cross-protocol Conformance addition to `brand.json`: when a house publishes a brand-agent advertising `verify_brand_claim` with the relevant claim type, consumers SHOULD prefer the agent's signed response over crawl-based mutual-assertion inference. The crawl path remains the fallback when the agent is unreachable or returns `unknown`.

Schema additions: `brand/verification-status.json` (enum), `brand/verify-brand-claim-request.json` (discriminated by claim_type), `brand/verify-brand-claim-response.json`. No changes to `brand.json` itself. Additive — every existing publisher and every existing brand-agent continues to work unchanged.

The single-tool design preserves AdCP's tool-count economy. New claim types (e.g., licensed_from, endorsement) are payload-discriminator additions, not new tools.

---
---

Draft RFC for the brand verification surface — three interrogative brand-agent tasks that let partners ask the brand authoritatively whether something belongs to it.

The RFC lives at `docs/brand-protocol/proposals/brand-verification-rfc.mdx`. Tracks the federated trust capability discussed in [#4521](https://github.com/adcontextprotocol/adcp/issues/4521) and supersedes the email-based self-healing path landed in PR #4505. Not yet normative — needs spec-owner sign-off before any agent implementations standardize.

New tasks proposed (all on the brand protocol surface, advertised in `get_adcp_capabilities` `supported_tasks`):

- `verify_subsidiary_claim` — "Is this brand a subsidiary of yours?" Replaces crawl-based mutual-assertion inference with the brand-agent's authoritative answer, including the `pending_review` and `disputed` states crawl cannot express.
- `verify_property` — "Is this site / app / property actually one of yours?" Returns ownership + the property-relationship enum (`owned` / `direct` / `delegated` / `ad_network`) plus optional per-use-case authorization.
- `verify_trademark` — "Is this trademark one of yours?" Returns ownership, licensing relationship, jurisdictions, Nice classes, and optional use-case authorization.

Shared `VerificationStatus` enum captures the rich state surface (`owned`, `pending_review`, `disputed`, `not_ours`, `licensed_in`, `licensed_out`, `unknown`). Public/authorized tier split mirrors `get_brand_identity`.

Cross-protocol Conformance addition to `brand.json`: when a house publishes a brand-agent advertising these tasks, consumers SHOULD prefer the agent's signed response over crawl-based mutual-assertion inference. The crawl path remains the fallback when the agent is unreachable or returns `unknown`.

Schema additions: `core/verification-status.json`, three request schemas, three response schemas. No changes to `brand.json` itself. Additive — every existing publisher and every existing brand-agent continues to work unchanged.

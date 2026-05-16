---
"adcontextprotocol": patch
---

Docs: implementer guidance for `verify_brand_claim` and consumer-side UI conventions for rejected claims.

`building-a-brand-agent.mdx` gains a new section, "Adding verify_brand_claim", covering the layered capability on top of the identity tier: capability declaration with `supported_claim_types`, the internal state model (subsidiary portfolio, parent declaration, property registry, trademark registry, pending-claim queue, archive), per-claim-type request validation and response shaping, the public-vs-authorized field split, the `pending_review` aging contract, per-purpose JWK setup (`adcp_use: "response-signing"` separate from `request-signing`), the `{caller_identity, claim_type, claim-target}` rate-limiting pattern with `Retry-After` and prefer-cached-prior-answer behavior, per-status `Cache-Control` recommendations, and a reference pattern for surfacing `pending_review` to the brand's portfolio team. The role table and deployment checklist are extended accordingly.

A new page, `docs/brand-protocol/ui-guidance.mdx`, collects consumer-side conventions for rendering `disputed` / `not_ours` rejections — DSP inventory shopping, portfolio explorer, creative-clearance, brand-safety pipelines. Covers attribution language (render rejections as the rejecting brand's first-person statement), recovery paths for the rejected leaf publisher (there is no protocol-level appeal — update or remove the claim), audit-trail recommendations (keep the signed envelope), and legal-exposure considerations (the consumer surface owns editorial framing; AdCP delivers the signed answer).

No schema changes. Both additions are non-normative consumer-side guidance — the canonical normative spec remains the `verify_brand_claim` task page.

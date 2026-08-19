---
"adcontextprotocol": patch
---

Complete direct-buy storyboard pricing and snapshot chaining.

Adds two missing conformance checks to `compact_direct_buy_lifecycle`:

1. Chains `pricing_version` through list → buy → accepted-snapshot validation, exercising the existing MUST requirement in `buy-products-request.json`.
2. Captures `accepted_proposal.proposal_id` and `accepted_proposal.terms_digest` from the buy response and compares both against `accepted_proposal_id` and `accepted_proposal_terms_digest` on readback, proving snapshot identity survives the operational-control phase.

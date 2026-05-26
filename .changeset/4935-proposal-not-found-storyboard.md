---
"adcontextprotocol": patch
---

media-buy: add `PROPOSAL_NOT_FOUND` compliance coverage for unknown proposal references.

The training agent now returns the canonical `PROPOSAL_NOT_FOUND` error with
`correctable` recovery for unknown `proposal_id` references in `get_products`
refine/finalize and `create_media_buy`, and prevalidates proposal refinements
before applying finalize side effects.

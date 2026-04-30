---
---

spec(media-buy): tighten get_products `buying_mode` timing semantics (counter-proposal to #3407)

#3407 proposed splitting `get_products` into two tools (`get_products` for catalog lookup, `request_proposal` for HITL proposal generation) on the grounds that one verb conflates a fast read with a slow workflow. Closing that issue won't-do because **the spec already has the catalog/proposal distinction in `buying_mode`** — `wholesale` is the catalog read, `brief` is the curated proposal, `refine` is iteration on either. The only real gap was that `buying_mode` description didn't say what each value implies about response timing, so a seller could legally route a `wholesale` request to the async/Submitted arm and surprise the buyer.

This patch sharpens the docstring + doc parameter table:

- `wholesale`: seller SHOULD return a synchronous response. MUST NOT route through the async/Submitted arm. Partial completion is signalled via the existing `incomplete[]` field (with optional `estimated_wait`), not a task handoff.
- `brief` and `refine`: MAY complete synchronously OR MAY return a `Submitted` envelope when curation needs upstream-system queries or HITL review the seller can't complete inside `time_budget`.
- Buyers needing predictable fast catalog access MUST use `wholesale`. Buyers open to slower curation use `brief` or `refine`.

This locks in the buyer-leverage that #3407's `request_proposal` tool was trying to provide, without forcing every seller to advertise a new capability or every buyer to implement two-tool dispatch logic. Aligns with the "same shape, variable timing" design ethic the spec already chose for the other 5 HITL tools tracked in #3392.

No schema-shape change — description text only. Build and schema validators pass clean.

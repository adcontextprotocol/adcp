---
---

compliance: add creative_fate_after_cancellation scenario to the media-buy seller track

PR #2623 pinned the normative rule that canceling or rejecting a media buy releases its package-creative assignments but leaves the creatives themselves in the library, reusable by `creative_id` on a subsequent buy. The rule closed a gap reported by an external contributor (#2254) and resolved #2262's open questions. The spec change had no runtime conformance test — every sales specialism tests `sync_creatives` during a successful flow, but none tested creative state after a buy cancel end-to-end. A seller that evaporated library creatives on cancel, or flipped them to `rejected` as a side effect, could pass every storyboard.

This scenario closes that gap with synchronous AdCP-API-only checks (no new infrastructure):

- **setup** — discover a product, create a media buy, sync a creative with an inline package assignment.
- **verify_creative_in_library_pre_cancel** — `list_creatives` returns the creative with a non-terminal review state (baseline).
- **cancel_buy** — `update_media_buy` with `canceled: true`.
- **verify_creative_persists_post_cancel** — `list_creatives` still returns the creative, status still in `{processing, pending_review, approved}`. A seller that returns an empty list, or has flipped the creative to `rejected` (implicit review cascade) or `archived` (evaporation on cancel), fails.
- **reuse_creative_on_new_buy** — create a second media buy, then `sync_creatives` assigning the original `creative_id` to the new package. Demonstrates end-to-end reusability.

Added to `media-buy/index.yaml` `requires_scenarios` so every media-buy seller claiming the track MUST pass it.

Sellers without a creative library grade this scenario `not_applicable` (noted in prerequisites).

No spec change. No schema change. Existing storyboards unchanged.

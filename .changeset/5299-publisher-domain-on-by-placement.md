---
"adcontextprotocol": minor
---

spec(media-buy): add optional `publisher_domain` to `get_media_buy_delivery` `by_placement` rows (closes #5299).

`by_placement` rows carried only `placement_id` and `placement_name`, so a buyer running across multiple publishers through one sales agent could not attribute delivered impressions to a publisher namespace without re-fetching `get_products` and cross-referencing the product's `placements[]` — a round-trip that requires retaining the buy-time catalog and breaks for inline placements.

Changes:

- `static/schemas/source/media-buy/get-media-buy-delivery-response.json` — add an optional `publisher_domain` (with the same domain regex as `core/placement.json`) to `by_placement` row items. It is a flat sibling of the existing `placement_id`/`placement_name` (not a nested PlacementRef — the row already ships those fields flat, so nesting would break consumers). Sellers SHOULD emit it whenever the resolving product placement carries a `publisher_domain` (always true for `kind: publisher_ref`); MAY omit only for `seller_inline` placements in a legacy single-publisher context. Single-valued because a placement resolves within exactly one publisher namespace. While in the block, add the missing `x-entity: "placement"` annotation to `placement_id` for parity with `core/placement.json` and `core/placement-ref.json`.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — note the optional `publisher_domain` field under "Available dimensions".

Strictly additive — no existing field changes shape, no new required fields. `by_placement` rows are already `additionalProperties: true`, and the obligation is SHOULD-when-known (not a retroactive MUST), so pre-existing single- and multi-publisher reports remain spec-valid.

Package-level publisher attribution on `get_media_buys` (the PackageStatus proposal in #5299's comments) is intentionally out of scope: an ad-network product can span multiple publishers, so a scalar there has an unresolved cardinality question (scalar-absent-when-multi vs. plural). This change covers only the placement grain, where the scalar is sound.

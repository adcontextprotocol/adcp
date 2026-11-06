---
"adcontextprotocol": minor
---

Withdraw the 3.3 additions to the deprecated `get_products` task and the deprecated `sync_creatives` `assignments[]` row, and move execution readiness to `list_products` (adcp#8501, entries 20–25 and the `get_products` rows of the deprecated-task table). 3.3 adds no field that exists only on a deprecated task. Where a live task lacks the capability, it moves there or waits for 4.0.

**All of these shipped in 3.3 betas and are removed after `3.3.0-beta.4`.** This is a beta-to-beta change, not a change to a stable release. The betas are immutable, so a seller or SDK built from a beta bundle has the surfaces below to remove.

**Exact-package forecasts on `get_products` (#8468, beta.1 to beta.4).** Removed: `refine[].package`, `media-buy/package-forecast-input.json`, the request rule tying `package` to `buying_mode: "refine"` and to non-finalize entries, and `refinement_applied[]` `result_product_id`, `resolved_start_time` and `resolved_end_time` with their `applied` rule. `refinement_applied` is optional again for every request. The forecast has no 3.3 home; where it belongs on the compact lifecycle is an open working-group question.

**`get_products` `filters.target_audiences` (#8215, experimental, beta.1 to beta.4).** Removed from `core/product-filters.json`, with its `dependencies` entry. It is planned for `list_products` `offer_filters` and `buy_products` purchases in 4.0 (`purchase_target_audiences_required_in_4_0`).

**Collection cards on `get_products` (#8141, experimental, beta.0 to beta.4).** Removed: the `include_collections` request flag, the response-level `collections` array and its `dependencies` entry, the `collections` branch of `get-products-rejected.json`, and `include_collections` in the `wholesale_feed_version` scope. `list_products`, `request_proposals` and `refine_proposals` keep both.

**Execution readiness (#7934, experimental, beta.1 to beta.4) moves to `list_products`.** `include_execution_readiness` leaves the `get_products` request and the `execution_readiness` map leaves its response. Both are added to the open `list_products` request and response, with the same shape and rules; the map is versioned independently of `feed_version` and is absent on an `unchanged` outcome. The `media_buy.execution_readiness` storyboard now drives `list_products`. `binding_field` now names the `buy_products` paths, `purchases[].optimization_goals[].event_sources[].event_source_id` and `purchases[].catalog_ids[]`, instead of the legacy `create_media_buy` `packages[]` paths, and `execution_requirements` documents the purchase binding beside the legacy one.

**`price_adjustments` on `get_products` pricing options (#7955, experimental, beta.1 to beta.4).** Removed from the `cpm`, `vcpm`, `cpc`, `cpcv`, `cpv`, `cpp` and `flat_rate` options with their `dependencies`, along with `pricing-options/price-adjustments.json`, `error-details/price-adjustments-mismatch.json`, the product rule that a placement-selection row requires `overlay_support.placement_selection`, the `price_adjustments_resolution` verifier constraint on `product-purchase.json`, and the `price-adjustments` test vectors. A seller stops listing `media_buy.price_adjustments`. The design is kept for the canonical pricing option in 4.0 (`canonical_price_adjustments_required_in_4_0`).

**`sync_creatives` `assignments[]` `landing_page_url` and `trackers` (#8180, #8220, beta.0 to beta.4).** Removed from the deprecated row, whose closed schema rejects them again. The `assignment_operations` `assign` operation keeps both.

The consumed changesets for these PRs stay in `.changeset/pre/` as history. The 3.3 release notes, What's new, the 3.2 to 3.3 migration guide, and the 3.3 beta page say what to remove under "Withdrawn from the deprecated tasks".

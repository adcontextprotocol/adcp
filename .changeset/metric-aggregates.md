---
"adcontextprotocol": minor
---

Add `metric_aggregates` partition to `aggregated_totals` on `get_media_buy_delivery` — qualifier-aware delivery rollups symmetric to `committed_metrics`. Closes #3848. Supersedes #3631 and #3833 (both already closed).

**The atomic unit is now identical across contract, diff, and delivery.** Each surface carries `(scope, metric_id, qualifier, …)` rows; reconciliation collapses to a row-level join on the tuple. `committed_metrics` adds `committed_at`; `missing_metrics` strips it; `metric_aggregates` swaps it for `value` plus per-metric component fields.

**Solves the apples-to-oranges sum problem.** MRC and GroupM viewability define materially different thresholds and must never be combined into a single cross-buy rate. The partition shape (one row per `(metric_id, full-qualifier-set)`) makes the partition explicit; future qualifier-aware metrics (`completion_rate` × completion threshold; attention scoring × methodology if it standardizes) plug into the same shape with no schema break.

**Schema additions.**

- `media-buy/get-media-buy-delivery-response.json` `aggregated_totals.metric_aggregates`: array of discriminated rows. Two oneOf branches (`scope: standard` / `scope: vendor`), reusing the qualifier shape from `core/package.json` `committed_metrics` and the BrandRef pattern from `core/vendor-metric-value.json`. Per-metric component fields (`measurable_impressions`, `viewable_impressions`, `impressions`, `completed_views`, `spend`, `conversions`, `conversion_value`, `clicks`) inlined as siblings of `value` rather than nested in a `components` sub-object — flatter, matches the per-buy `viewability` block's existing flat shape, leaves room for `oneOf` discriminated on `metric_id` to enforce per-metric required components in a future minor if conformance testing turns up gaps.
- `core/package.json` `committed_metrics` description updated to cross-link `aggregated_totals.metric_aggregates` and articulate the row-symmetric model across contract / diff / delivery.

**Granularity rule.** One row per `(metric_id, full-qualifier-set)`, reported at the finest available granularity. Buyers re-aggregate up if they want a coarser view. Eliminates rollup ambiguity and prevents accidental double-counting.

**Open delivery vocabulary, closed contract vocabulary.** `committed_metrics.qualifier` is closed (`additionalProperties: false`, today only `viewability_standard`). `metric_aggregates.qualifier` is also closed today but reserves additional keys for transparency disclosures buyers don't commit to (e.g., `tracker_firing` pending #3832). The delivery vocabulary is therefore a deliberate **superset** of the contract vocabulary — explicit, not accidental.

**Unqualified metrics stay top-level.** `impressions`, `spend`, `media_buy_count`, etc. remain at the top of `aggregated_totals`. `metric_aggregates` is only used for metrics with non-empty qualifier sets. Avoids duplicate sources of truth.

**Per-buy shape stays flat.** Each individual buy is single-qualifier by definition; only the cross-buy aggregate spans qualifiers. Per-buy `totals.viewability` continues to be a flat object with its own `standard` field.

**Value typing.** Heterogeneous by `metric_id` (rate vs count vs ratio). Buyer agents MUST inspect `metric_id` before doing arithmetic — same dispatch convention as `committed_metrics`. Documented in the description and in `docs/media-buy/task-reference/get_media_buy_delivery.mdx`.

**Backwards compatibility.** Additive. The field is optional in v1 (`additionalProperties: true` on `aggregated_totals` already permitted ad-hoc partition fields like the original Vox `viewability` insertion); existing clients are unchanged.

Doc updates: `docs/media-buy/task-reference/get_media_buy_delivery.mdx` adds an "Aggregated metric partitions" section documenting the reconciliation join, granularity rule, qualifier-vocabulary asymmetry, per-buy / aggregate divergence, and value-typing dispatch.

Closes #3848.

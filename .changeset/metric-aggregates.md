---
"adcontextprotocol": minor
---

Add `metric_aggregates` partition to `aggregated_totals` on `get_media_buy_delivery` — qualifier-aware delivery rollups symmetric to `committed_metrics`. Closes #3848. Supersedes #3631 and #3833 (both already closed).

**The atomic unit is now identical across contract, diff, and delivery.** Each surface carries `(scope, metric_id, qualifier, …)` rows; reconciliation collapses to a row-level join on the tuple. `committed_metrics` adds `committed_at`; `missing_metrics` strips it; `metric_aggregates` swaps it for `value` plus per-metric component fields.

**Provides the structural primitive for solving apples-to-oranges sums.** MRC and GroupM viewability define materially different thresholds and must never be combined into a single cross-buy rate. The partition shape (one row per `(metric_id, full-qualifier-set)`) makes the partition expressible; future qualifier-aware metrics (`completion_rate` × completion threshold; attention scoring × methodology if it standardizes) plug into the same shape with no schema break. Note: this PR ships the *structure* — sellers actually emitting partitioned rows requires a forcing function from the contract surface (buyers committing to specific qualifiers via `committed_metrics`) plus seller adoption. Expect adoption to lag the structure until a real contract demand exists.

**Schema additions.**

- `media-buy/get-media-buy-delivery-response.json` `aggregated_totals.metric_aggregates`: array of discriminated rows. Two oneOf branches (`scope: standard` / `scope: vendor`), `additionalProperties: false` on both (matching `committed_metrics` symmetry), reusing the qualifier shape from `core/package.json` `committed_metrics` and the BrandRef pattern from `core/vendor-metric-value.json`. Per-metric component fields (`measurable_impressions`, `viewable_impressions`, `impressions`, `completed_views`, `spend`, `conversions`, `conversion_value`, `clicks`) inlined as siblings of `value` rather than nested in a `components` sub-object — flatter, matches the per-buy `viewability` block's existing flat shape. Per-metric required components enforced via `if/then` for the four highest-traffic metrics (`viewable_rate`, `completion_rate`, `cost_per_acquisition`, `roas`); other metrics rely on prose-described components today (full `oneOf` discriminated on `metric_id` would be 31+ branches; deferred to a future minor if conformance testing demands).
- `core/package.json` `committed_metrics` description updated to cross-link `aggregated_totals.metric_aggregates` and articulate the row-symmetric model across contract / diff / delivery.

**Granularity rule.** One row per `(metric_id, full-qualifier-set)`, reported at the finest available granularity. Buyers re-aggregate up if they want a coarser view. Eliminates rollup ambiguity and prevents accidental double-counting.

**Closed today, expected to diverge.** `committed_metrics.qualifier` and `metric_aggregates.qualifier` are both `additionalProperties: false` today with identical content (`viewability_standard` only). The delivery vocabulary is **expected to diverge from contract** in future minors as transparency disclosures buyers don't commit to ship delivery-only (e.g., `tracker_firing` pending #3832). New keys ship explicitly in subsequent minors on either surface.

**Unqualified metrics stay top-level; mutual exclusion MUST.** `impressions`, `spend`, `media_buy_count`, etc. remain at the top of `aggregated_totals`. `metric_aggregates` is only used for metrics with non-empty qualifier sets. **For any `metric_id` appearing in `metric_aggregates`, the corresponding top-level scalar in `aggregated_totals` MUST be omitted (not zeroed)** — sellers MUST NOT emit both. Avoids duplicate sources of truth.

**Qualifier-set drift across reports.** When a campaign gains a new qualifier mid-flight (e.g., adds `tracker_firing` partitioning in week 2 after only client-side firing in week 1), prior periods' rows remain valid at their original granularity. Buyers SHOULD NOT retroactively repartition.

**Per-buy shape stays flat.** Each individual buy is single-qualifier by definition; only the cross-buy aggregate spans qualifiers. Per-buy `totals.viewability` continues to be a flat object with its own `standard` field.

**Value typing.** Heterogeneous by `metric_id` (rate vs count vs ratio). Buyer agents MUST inspect `metric_id` before doing arithmetic — same dispatch convention as `committed_metrics`. Documented in the description and in `docs/media-buy/task-reference/get_media_buy_delivery.mdx`.

**Backwards compatibility.** Additive. The field is optional in v1 (`additionalProperties: true` on `aggregated_totals` already permitted ad-hoc partition fields like the original Vox `viewability` insertion); existing clients are unchanged.

Doc updates: `docs/media-buy/task-reference/get_media_buy_delivery.mdx` adds an "Aggregated metric partitions" section documenting the reconciliation join, granularity rule, qualifier-vocabulary asymmetry, per-buy / aggregate divergence, and value-typing dispatch.

Closes #3848.

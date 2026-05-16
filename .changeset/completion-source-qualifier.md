---
"adcontextprotocol": minor
---

Add `completion_source` qualifier key to disambiguate seller-attested vs vendor-attested `completion_rate`. Closes #3861 with Option C from the issue.

**The hybrid problem.** `completion_rate` is dual-natured: the seller witnesses completion via player events (the seller's player fired the completion beacon), and third-party measurement vendors can independently attest to completion via SDK callbacks, panel methodology, or server-side beacon validation. The two paths can yield materially different rates — particularly in SSAI environments where the player's view of completion may differ from a vendor's. Same `metric_id`, two semantics — exactly the case the [taxonomy doc](https://docs.adcontextprotocol.org/docs/measurement/taxonomy)'s working rule of thumb addresses ("if two layers seem to claim the same field, the field is probably two fields wearing one name — split it").

**The qualifier slot is the right home.** Instead of splitting the metric_id (`seller_completion_rate` vs `verified_completion_rate`), surface the dual nature at the qualifier layer that #3576 already established for viewability. Viewability is now joined by completion_rate as a Tier 1 graduated metric using the qualifier slot — proves the pattern is generalizable, not viewability-specific.

**Schemas added.**

- `enums/completion-source.json`: closed enum `["seller_attested", "vendor_attested"]` with descriptions.

**Schemas updated.**

- `core/package.json` `committed_metrics.qualifier`: adds `completion_source` alongside `viewability_standard`. MUST be set when `metric_id` is `completion_rate` and the seller commits to a specific source.
- `media-buy/package-request.json` `committed_metrics.qualifier`: same shape on the buyer-side request surface.
- `media-buy/get-media-buy-delivery-response.json` `aggregated_totals.metric_aggregates.qualifier`: adds `completion_source` for partitioned delivery rollups by source.
- `media-buy/get-media-buy-delivery-response.json` `by_package[].missing_metrics.qualifier`: adds `completion_source` for accountability — a buyer expecting vendor-attested completion flags a seller-attested-only delivery report as missing the vendor commitment.

**Vendor identity** is anchored on the matching `performance_standard.vendor` BrandRef in the buy contract, not duplicated on the metric row. Same pattern as MRC viewability anchored on `performance_standard.vendor` for the DV/IAS/etc. case.

**Reconciliation.** The atomic-unit join `(scope, metric_id, qualifier)` from #3576 + #3848 (just-merged `metric_aggregates`) extends naturally — completion_rate rows now carry a `completion_source` qualifier, joined like viewability_standard rows. No reconciliation logic changes; new keys plug into the existing slot.

**Doc updates.**

- `docs/media-buy/task-reference/create_media_buy.mdx` — `committed_metrics` reporting contract section now lists both qualifier keys (viewability_standard and completion_source) with their conditional-required semantics.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — qualifier vocabulary section names both keys; missing_metrics description shows the completion_source flagging example.

**Backwards compatibility.** Additive. Existing `committed_metrics` / `missing_metrics` / `metric_aggregates` consumers without qualifier-aware reconciliation continue to work; the closed-vocabulary nature of qualifier means new keys appear only in subsequent minors with explicit migration paths.

Closes #3861.

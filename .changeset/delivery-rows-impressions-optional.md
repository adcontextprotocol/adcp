---
"adcontextprotocol": minor
---

`impressions` becomes optional on delivery rows (#8089). It leaves the `required` arrays of `get_media_buy_delivery` `daily_breakdown` rows (media-buy and package grain) and of the `by_format`, `by_device_type`, `by_device_platform`, `by_audience`, `by_demographic`, `by_installment`, `by_collection`, `by_placement`, `by_property`, `by_geo`, `by_keyword`, `by_creative` and `by_catalog_item` rows (and their `_property` variants), so the field becomes optional in SDK-generated types. Identity keys and `spend` stay required, and `aggregated_totals` still requires `impressions`.

An absent `impressions` means the seller did not measure impressions for that row; it does not mean zero. Receivers MUST NOT treat absence as zero or derive impression-denominated values for the row (`cpm`, `ctr`, `completion_rate`, `viewable_rate`), and senders MUST omit impression-denominated rates on such a row. Senders MUST NOT put views, plays, downloads or any other count in `impressions`; those go in `views`, `completed_views`, `plays`, `downloads` or `vendor_metric_values`. When `impressions` is a committed metric, absence is disclosed through `by_package[].missing_metrics`.

Version gate: sellers MUST NOT omit `impressions` from these rows toward callers pinned below AdCP 3.3, and a caller with no declared pin is treated as pinned below 3.3. Toward those callers a seller with no impression count omits the row. The rule applies regardless of `pricing_model`.

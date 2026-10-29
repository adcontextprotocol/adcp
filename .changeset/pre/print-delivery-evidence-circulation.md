---
"adcontextprotocol": minor
---

Add experimental `print_metrics` (registered with the existing `ooh_metrics` under experimental feature id `media_buy.offline_delivery_metrics`) to `core/delivery-metrics.json` for print proof-of-insertion and circulation reporting: `page_delivered`, `position_delivered`, `circulation_delivered`, `circulation_basis` (`audited` | `seller_modeled`), and a `placement-evidence` tearsheet `evidence`. `by_installment` rows inherit it, so each issue reports its own evidence and circulation. All fields are optional; `print_metrics` is added to the `available-metric` enum so sellers can commit to it and report a gap through `missing_metrics`. Documents the SHOULD-populate guidance for guaranteed print products and the rule that circulation falls back to the product's declared `delivery_measurement` absent a per-issue figure in `print.mdx`. Closes #5684, #5687.

---
"adcontextprotocol": patch
---

Allow `null` for video-only delivery metrics (`quartile_data`, `completion_rate`). Sellers running non-video inventory (display, audio-only, DOOH-without-video) legitimately have no value for these metrics, and returning `null` is the correct "not applicable" signal. The schema previously required `type: "number"` / `type: "object"` and rejected `null`, causing receivers to fail validation on every valid display-inventory delivery report.

`delivery-metrics.json` (`totals` / `by_package[]`) now accepts `["number", "null"]` for `completion_rate` and `["object", "null"]` for `quartile_data`; `get-media-buy-delivery-response.json` `aggregated_totals.completion_rate` gets the same loosening so the aggregate path can't re-trigger the failure. The `minimum`/`maximum` constraints on `completion_rate` still apply to non-null values, and the type stays narrowed to null (no strings/arrays). Every other delivery metric continues to signal "not applicable" by omission, not `null` — this exception is scoped to the two video-only fields. Spec-loosening for the receiver contract: producers already sending numbers/objects remain valid.

The separate inline `completion_rate` in `report-plan-outcome-request.json` (a governance self-report block, not on the `get_media_buy_delivery` path) is intentionally left unchanged.

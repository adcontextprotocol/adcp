---
"adcontextprotocol": minor
---

Require sellers to omit a metric's flat carrier from per-buy `totals` and every window slice's `totals` (in `get_media_buy_delivery` responses; per-buy only in delivery webhook results) when any `by_package[].metric_values` carries more than one qualifier set for that `metric_id`, mirroring the mixed-currency omission pattern. The identity key for "one row" is `(scope, metric_id, qualifier)`. `impressions`, `spend` and "always included" metrics are unaffected. Refs #6628.

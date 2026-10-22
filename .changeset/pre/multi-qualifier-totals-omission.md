---
"adcontextprotocol": minor
---

Require sellers to omit a metric's flat carrier from per-buy `totals` and every window slice's `totals` (in `get_media_buy_delivery` responses; per-buy only in delivery webhook results) when the buy's packages report that `metric_id` under more than one qualifier set, whether in `by_package[].metric_values` or in a package's flat carrier. The rule applies across packages, so e.g. one package at `mrc` and another at `groupm` no longer combine into one flat `viewability`. It mirrors the mixed-currency omission pattern. The identity key for "one row" is `(scope, metric_id, qualifier)`. `impressions`, `spend` and "always included" metrics are unaffected. Refs #6628.

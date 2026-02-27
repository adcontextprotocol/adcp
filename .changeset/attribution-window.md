---
"adcontextprotocol": minor
---

Add attribution window metadata to delivery response. The response root now includes an optional `attribution_window` object describing `click_through_days`, `view_through_days`, and attribution `model` (last_touch, first_touch, linear, time_decay, data_driven). Placed at response level since all media buys from a single seller share the same attribution methodology. Enables cross-platform comparison of conversion metrics.

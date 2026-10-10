---
"adcontextprotocol": minor
---

Make "advertise only what you accept" a normative rule for product `measurement_terms`. A seller MUST NOT advertise a `measurement_window` (or other term value) that it would reject with `TERMS_REJECTED` when a buyer replays those terms unchanged on `create_media_buy`, and the window MUST reference a `window_id` declared in `reporting_capabilities.measurement_windows`. Documented in `get_products` and `create_media_buy`, and the `measurement_terms_accepted` storyboard prerequisite now states that a rejection of replayed advertised terms is a seller conformance failure. Closes #7345.

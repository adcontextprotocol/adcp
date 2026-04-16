---
"adcontextprotocol": patch
---

Generalize `measurement_window` beyond broadcast TV. The concept — a maturation stage with its own expected data availability — applies equally to DOOH (`tentative` → `final` after IVT/fraud-check), digital with IVT filtering (`post_givt` → `post_sivt`), podcast (`downloads_7d` → `downloads_30d`), and any other channel where billing-grade data arrives in phases. The schema mechanism is unchanged; descriptions and examples on `measurement-window.json`, `reporting-capabilities.measurement_windows`, and `measurement-terms.billing_measurement.measurement_window` have been broadened so sellers in those channels know this is where they declare their maturation/processing cycle. Accountability, optimization-reporting, and get_media_buy_delivery docs updated to match. No field additions or removals.

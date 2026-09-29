---
"adcontextprotocol": patch
---

Correct the `views` entry in the optimization goal `metric` description. It said `views` meant viewable impressions, which contradicted the delivery-metrics definition of `views` (content views counted toward the billable view threshold, the quantity CPV bills on) and duplicated the dedicated `viewable_rate` goal. The description now matches delivery-metrics and points viewability goals at `viewable_rate`. No enum, type or validation change.

---
"adcontextprotocol": patch
---

Tighten the unreleased `viewable_rate` optimization goal before 3.2.0-rc.7. The legacy goal shape now accepts only `threshold_rate` targets for `viewable_rate`, so a meaningless `cost_per` target is rejected rather than silently capped at 1. Viewability `standard` and `vendor` are now allowed on `viewed_seconds` goals too, which were already governed by the viewability standard, and both goal shapes reject those fields on other metrics. The migration guide documents the `BrandRef`-to-`BrandKey` vendor mapping when converting legacy goals to the canonical shape.

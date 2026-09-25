---
"adcontextprotocol": patch
---

Declare the deprecated `account` field in `media-buy/list-creative-formats-request.json` so the universal `pagination_integrity_creative_formats` storyboard keeps its account scoping against media-buy agents. Previously the runner stripped `account` and emitted `input_schema_field_stripped`, so sellers that scope seeded formats by account could return a different result set during the pagination walk.

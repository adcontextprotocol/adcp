---
"adcontextprotocol": patch
---

Declare `account` in `media-buy/list-creative-formats-request.json` (matching the creative variant) so the universal `pagination_integrity_creative_formats` storyboard's account-scoped pagination walk no longer triggers spurious `input_schema_field_stripped` notices against media-buy agents. Removes the two lint-test exemptions for those storyboard steps.

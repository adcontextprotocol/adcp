---
"adcontextprotocol": patch
---

Add `stale_response_advisory` universal storyboard verifying STALE_RESPONSE wire placement (advisory in `errors[]` on populated success response, transport stays success). Adds `force_upstream_unavailable` scenario to comply_test_controller request/response schemas so sellers can deterministically exercise stale-cache fallback paths in compliance testing.

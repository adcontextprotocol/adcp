---
"adcontextprotocol": patch
---

Add compliance storyboard coverage for `refine[]` finalize-exclusivity and `MULTI_FINALIZE_UNSUPPORTED`.

New scenario `media_buy_seller/refine_finalize_exclusivity` tests the three normative negative cases clarified in issue #4107:
1. Mixed finalize + non-finalize entries in a single `refine[]` call — rejected with `INVALID_REQUEST`.
2. Non-proposal-scoped finalize entry — rejected with `INVALID_REQUEST` (schema-invalid input).
3. Multi-proposal finalize — either handled atomically or rejected with `MULTI_FINALIZE_UNSUPPORTED` / `INVALID_REQUEST` (branch set).

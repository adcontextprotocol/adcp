---
"adcontextprotocol": patch
---

Make `criteria.outcome_target` inert on `list_products` for every seller. `list_products` returns no proposals, so the field has no answer there; it does not filter or rank products and MUST NOT cause a rejection beyond schema validation, whether or not the seller declares `media_buy.outcome_target`. Before this change, the rule that non-declaring sellers reject the field with `UNSUPPORTED_FEATURE` applied to `list_products` too, while declaring sellers gave the same request a normal product list. The `UNSUPPORTED_FEATURE` rule now applies to `request_proposals` and proposal refinement, where declaring sellers answer. Buyers can reuse one `criteria` object across both tasks.

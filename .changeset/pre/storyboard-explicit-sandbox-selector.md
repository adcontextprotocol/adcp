---
"adcontextprotocol": patch
---

Compliance storyboards that seed a `sandbox: true` fixture account now carry `sandbox: true` explicitly on every `sample_request.account` that names that fixture's natural key, starting with `media_buy_seller/invalid_transitions`. Previously those requests relied on the runner to inject the selector, and the injection was not uniform across steps. A seller that correctly treats `(brand, operator, sandbox: true)` as a distinct account from `(brand, operator)` could not resolve the buy created on `create_media_buy` from the follow-up `update_media_buy`, so `update_unknown_package` returned `MEDIA_BUY_NOT_FOUND` and the two `double_cancel` steps were skipped. This is a conformance artifact only: no schema or wire-contract change. Wholesale `get_products` requests keep their omitted-selector semantics.

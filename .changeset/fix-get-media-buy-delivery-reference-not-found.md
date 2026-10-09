---
"adcontextprotocol": patch
---

Replace phantom `REPORTING_REVISION_NOT_FOUND` with `REFERENCE_NOT_FOUND` in `get_media_buy_delivery` task reference. The phantom code was never in the error-code enum; the enum's own MUST rule requires `REFERENCE_NOT_FOUND` for typed parameters without a dedicated standard code. Fixes #8083.

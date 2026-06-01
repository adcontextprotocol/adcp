---
---

docs: remove phantom `FORMAT_INCOMPATIBLE` error code from create_media_buy reference.

`FORMAT_INCOMPATIBLE` was documented in the error table and two JSON examples in `create_media_buy.mdx` but was never present in `static/schemas/source/enums/error-code.json`. SDKs that validate `errors[].code` against the published enum would treat seller responses using this code as unknown codes. Replaced with `UNSUPPORTED_FEATURE` (the code already used for the v2/capability_ids path) to make the v1/v2 error paths symmetric. The `FORMAT_INCOMPATIBLE` table row was removed and its v1-path guidance folded into the existing `UNSUPPORTED_FEATURE` row to avoid duplicate-code agent-parseability confusion.

Closes #4852. Surfaced during review of #4845.

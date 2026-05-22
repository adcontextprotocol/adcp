---
"adcontextprotocol": patch
---

Fix phantom `FORMAT_INCOMPATIBLE` error code on `create_media_buy` docs. The code was referenced in the error table and two response examples on `docs/media-buy/task-reference/create_media_buy.mdx` but was never defined in `static/schemas/source/enums/error-code.json`. SDKs that validate `errors[].code` against the published enum would reject responses built from the docs literally.

Migrated all three references to `UNSUPPORTED_FEATURE` — the enum value whose semantics ("a requested feature or field is not supported by this seller") match the "format not in the product's accepted set" case exactly. The error-table row was also merged with the sibling `UNSUPPORTED_FEATURE` row added in #4845 (which covered the v2 `capability_ids[]` failure modes), so a single row now spans both v1 (`format_ids[]`) and v2 (`capability_ids[]`) format-mismatch cases.

Closes #4852.

---
---

Bump `@adcp/client` to `^5.8.1` and align training-agent responses with the stricter response-schema validation it enables. Four training-agent response construction fixes:

- `list_creative_formats`: catalog asset requirements use `catalog_type` (singular) not `catalog_types`; `print_full_page` artwork and `radio_spot` audio use the correct `image`/`audio` asset types (not the non-existent `file` type); `print_full_page` dimensions use `inches` (not the invalid `in`).
- `validate_property_delivery`: drop the non-schema `compliant` root field and emit per-record validation evidence as schema-compliant `features[]` entries (not a non-schema `violations[]`).
- `get_media_buys`: include the required `total_budget` on each media buy, summed from package budgets.

Restores the storyboard CI non-regression floors (legacy 35 clean / 279 passing; framework 21 clean / 237 passing) — local run measures legacy 36 clean / 295 passing and framework 21 clean / 241 passing. Unblocks adopting the `contributes: true` shorthand (adcp-client#693) on `schema-validation.yaml` and `security.yaml`.

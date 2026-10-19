---
"adcontextprotocol": patch
---

Grade inline creative paths on what each seller actually publishes, without inventing a dual-emission requirement.

`inline_creatives_without_sync` required a product carrying canonical `format_options[]` and treated the legacy `format_ids[]` path as `optional`, so canonical-only, legacy-only and non-projectable-legacy sellers were graded wrongly. One canonical discovery now captures the product's whole format declaration alongside its product and pricing identifiers, and three mutually exclusive canonical paths run off that single response: product-scoped `format_option_refs`, publisher-scoped refs carrying `publisher_domain`, and an unnamed option authored with `format_kind` alone. The legacy `format_ids[]` path runs independently. Because each path discovers and buys from one `get_products` response, a seller whose brief-mode results reorder or change between calls is never failed for it. Execution and readback phases stay required, so once a representation was captured, inline create, update and readback on it must work.

A publisher-catalog-backed option previously received a product-scoped reference, which `core/format-option-ref.json` rejects — a valid seller failed. `format_option_id` is also no longer required, because `core/product-format-declaration.json`, which `products[].format_options[]` references, requires only `format_kind` and `params`.

The legacy probe stays unfiltered: a non-projectable legacy format has no canonical kind to match, so filtering it by `format_kinds` would exclude the very sellers this corrects. Its fixed 300x250 image asset is documented as an applicability limit instead.

`scripts/lint-storyboard-sample-request-schema.cjs` needed one narrow change so a whole-declaration ref placeholder resolves: in `placeholderFor`'s object arm, a node that declares no `properties` of its own now falls back to its first object branch. `resolveSchemaNode` is deliberately untouched — widening it there changed resolution for dozens of unrelated nodes and introduced placeholder drift rather than revealing it. No allowlist entry is required.

Make the three provenance storyboards' seeded products complete: they were missing the schema-required `publisher_properties` and `reporting_capabilities`, and their CPM pricing option carried a `rate` field the schema ignores, so the product advertised no price at all. They now declare `fixed_price` and an image format option matching their creative probes.

Adopters: a seller whose product advertises `format_ids[]` will newly fail this storyboard if it does not accept inline creatives on that representation. Either fix the legacy path, or stop projecting to `format_ids[]` and advertise `format_options[]` alone — `format_ids` is deprecated in 3.2 and removed in 4.0, and a canonical-only product skips the legacy path cleanly. The `verify_replacement` phase is gone and the readback steps now live in their path phases, so diagnostics keyed on that phase id will see new keys.

---
"adcontextprotocol": minor
---

Grade inline creative paths on what each seller actually publishes, without inventing a dual-emission requirement.

`inline_creatives_without_sync` previously required a product carrying canonical `format_options[]` and treated the legacy `format_ids[]` path as `optional`. It now has three execution paths — canonical selected through `packages[].format_option_refs`, canonical with no stable `format_option_id`, and legacy `format_ids[]` — each preceded by its own optional discovery phase. A path runs only when its own discovery captured the selector it needs, and it buys with the product, pricing option and selector captured from that same `get_products` response. Because the gate and the buy come from one response, a seller whose brief-mode results reorder or change between calls is never failed for it. Execution phases are not optional, so once a representation was actually captured, inline create, update and readback on it must work.

`format_option_id` is not required: `core/canonical-format-option.json` requires only `format_kind` and `params`, so a product may advertise a usable canonical option with no stable id. That seller is graded on the unnamed-option path instead of being silently skipped.

Make the three provenance storyboards' seeded products complete: they were missing the schema-required `publisher_properties` and `reporting_capabilities`, and their CPM pricing option carried a `rate` field the schema ignores, so the product advertised no price at all. They now declare `fixed_price` and an image format option matching their creative probes.

Adopters: a seller whose product advertises `format_ids[]` will newly fail this storyboard if it does not accept inline creatives on that representation. Either fix the legacy path, or stop projecting to `format_ids[]` and advertise `format_options[]` alone — `format_ids` is deprecated in 3.2 and removed in 4.0, and a canonical-only product skips the legacy path cleanly. The `verify_replacement` phase is gone and the readback steps now live in their path phases, so diagnostics keyed on that phase id will see new keys.

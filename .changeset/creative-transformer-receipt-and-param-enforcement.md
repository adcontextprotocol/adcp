---
"adcontextprotocol": patch
---

spec(creative): harden the unreleased 3.1 creative-transformer surface — make three already-documented normative rules schema-enforceable, and fix a self-contradictory `leaves_total` formula.

These refine the 3.1 transformer / `build_creative` multiplicity feature before GA. No new surface; each change makes an existing MUST checkable or corrects a description.

- **Per-leaf pricing receipt is now enforced when a build reports cost.** `BuildCreativeVariantSuccess` documents that untrafficked best-of-N / fan-out leaves are billed via the inline per-leaf `vendor_cost` *only* (they never earn a `creative_id`, so never reach `report_usage`), and that the aggregate `vendor_cost` MUST equal the sum of the per-leaf values — but the leaf only required `[build_variant_id, creative_manifest]`, so a paid agent could bill N leaves and return no machine-readable cost for any of them. Added: (a) a branch-level `if (aggregate vendor_cost present) then` each produced leaf requires `vendor_cost` + `currency`; (b) per-leaf `dependencies` so a leaf can't carry a partial receipt (`vendor_cost`↔`currency` co-required; `pricing_option_id` ⇒ both). A genuinely free build omits the aggregate and is unaffected; a CPM-deferred leaf reports `vendor_cost: 0` (a value, not an omission).

- **`transformer-param.json` `value_source` now binds to its descriptor.** The prose already stated the rules (`inline` ⇒ `allowed_values`; `range` ⇒ `minimum`/`maximum`; `free_text` ⇒ `type: string` and `allowed_values`/`minimum`/`maximum`/`options`/`options_cursor` absent), but nothing enforced them. Added `allOf` `if/then` blocks. `enumerable` is intentionally unconstrained — its `options[]` are returned only when expanded via `expand_params`.

- **Fixed the `leaves_total` formula.** The `conditions_total` field documented the three-factor product (`items_to_produce × conditions_total × variants_per_item`) while the `leaves_total` field two lines down — and the `BuildCreativeVariantSuccess.leaves_total` description — stated the two-factor product, so an agent computing expected leaves from the field's own description under-counted by a factor of `conditions_total` whenever `signal_conditions` was present. All three now state the conditions factor consistently. Docs (`build_creative.mdx`, `creative-transformers.mdx` migration guide) updated to match.

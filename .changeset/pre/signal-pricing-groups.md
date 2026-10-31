---
"adcontextprotocol": minor
---

Add experimental signal pricing groups (`signals.pricing_groups`). An optional `pricing_group` on the shared signal-listing fields (`get_signals` results and `Product.signal_targeting_options[]`, product-scoped value overrides) and `signal_pricing_group_rules[]` (`{pricing_group, pricing_combination: highest | each}`) on `signal_targeting_rules` and the `get_signals` response let a seller declare that signals such as alternative age bands price as one audience. A group with no rule and every ungrouped signal is charged `each`; `flat_fee`, `per_unit`, `custom` and `percent_of_media` options are always charged `each`. Refs #7898.

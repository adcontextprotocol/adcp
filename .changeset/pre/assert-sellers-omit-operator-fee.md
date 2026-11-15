---
"adcontextprotocol": patch
---

Compliance storyboards now check that sellers never author `operator_fee` (adcp#8367). `media_buy_seller/product_filter_behavior` checks `get_products` `pricing_options[].eligible_adjustments[]` and `pricing_options[].price_breakdown.adjustments[].kind`. `media_buy_seller/total_budget_redistribution` checks `create_media_buy` `packages[].price_breakdown.adjustments[].kind` and `update_media_buy` `affected_packages[].price_breakdown.adjustments[].kind`. The checks pass when a seller returns no breakdown or `eligible_adjustments`. They are advisory until runner capability version 17.0.0 and then become required. `total_budget_redistribution` now declares `requires: field_excludes_runner`, which the storyboard schema mandates for `field_excludes`.

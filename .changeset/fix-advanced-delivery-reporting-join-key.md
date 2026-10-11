---
"adcontextprotocol": patch
---

fix(compliance): add operator_unit join key to advanced_delivery_reporting storyboard

The `advanced_delivery_reporting` storyboard was missing the `account.operator_unit.id`
join key on all graded steps (`sync_account`, `discover_product`, `create_buy`,
`get_narrowed_format_delivery`). Without this key, the controller-seeded product
(`advanced_reporting_video`) could not be resolved by any seller because nothing on
the wire linked the harness-identity seed to the acme-account reads. The storyboard
graded `partial` on fully-conformant sellers.

Adds `operator_unit.id: compliance-media_buy_seller_advanced_delivery_r-a37f01cb`
to all four steps, matching the isolation pattern used by every other
controller-seeded storyboard in the bundle. Bumps version to 1.0.3.

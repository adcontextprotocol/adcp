---
---

Bump `@adcp/client` from `5.13.0` to `5.15.0` and align training-agent
seller catalog with spec test-kit fixtures.

`@adcp/client` 5.15.0 ships the two regression fixes from 5.14.0 that
had blocked this pin:

- Schema loader pre-registers non-tool fragments from every flat-tree
  domain directory, unblocking `$ref` resolution for governance, brand,
  property, collection, content-standards, account, and signals tools.
- `create_media_buy` enricher: fixture-authored `product_id` /
  `pricing_option_id` / `bid_price` on `packages[0]` now win over
  discovery-derived values. Sentinel literals `"test-product"` and
  `"test-pricing"` still defer to discovery.

Side-effects for our training agent: storyboards that hardcode a
real (non-sentinel) product or pricing id in `packages[0]` now require
the agent's catalog to actually contain that id. Three mismatches
surfaced, all fixed by catalog alignment:

- `product-factory.ts`: aliased `outdoor_ctv_q2` (CTV publisher) and
  `local_display_dynamic` (first publisher) with `cpm_standard`
  pricing — pattern already established for `test-product`,
  `sports_ctv_q2`. Closes `media_buy_seller/governance_conditions`
  and `sales_catalog_driven`.
- `signal-providers.ts`: renamed `po_prism_ltv_flat` →
  `po_prism_flat_monthly` and `po_prism_cart_cpm` →
  `po_prism_abandoner_cpm` to match `test-kits/nova-motors.yaml`.
  Closes `signal_owned/activate_on_platform` and `activate_on_agent`.

Storyboard CI floors raised to the new clean baseline (legacy
378 → 380, framework 390 → 393). Storyboard counts stay 52/52.

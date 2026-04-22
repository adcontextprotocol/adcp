---
---

Storyboards: add `controller_seeding: true` + `fixtures:` blocks on six
storyboards whose `create_media_buy` steps author multi-package payloads
referencing products that don't exist in any reasonable seller catalog
by default. After `@adcp/client` 5.12 (adcp-client#794), the storyboard
runner emits every authored package instead of silently dropping
`packages[1+]`. Sellers without these products then hit
`PRODUCT_NOT_FOUND: Package 1: Product not found: <id>` and cascading
step failures in their conformance runs.

Wires the SDK's fixture-seeding feature (adcp-client#790) on the six
storyboards so `packages[1+].product_id` / `pricing_option_id` resolve
against seeded fixtures regardless of the seller's default catalog:

- `protocols/media-buy/index.yaml` — seeds `sports_preroll_q2`,
  `lifestyle_display_q2` + pricing.
- `protocols/media-buy/scenarios/delivery_reporting.yaml` — seeds
  `outdoor_display_q2`, `outdoor_video_q2` + pricing.
- `protocols/media-buy/scenarios/governance_approved.yaml` — same pair.
- `specialisms/creative-generative/generative-seller.yaml` — same pair.
- `specialisms/sales-broadcast-tv/index.yaml` — seeds `primetime_30s_mf`,
  `late_fringe_15s_mf` with broadcast-spot formats + unit pricing.
- `specialisms/sales-guaranteed/index.yaml` — seeds
  `sports_preroll_q2_guaranteed`, `outdoor_ctv_q2_guaranteed` with
  guaranteed-fixed CPM pricing.

All pricing uses `fixed_price` (rather than `floor_price`) so the
non-auction bid-price requirement doesn't trip storyboards that omit
`bid_price`.

Validated by overlaying the edited YAMLs into `@adcp/client`'s
compliance cache and re-running via `adcp storyboard run` — seed phase
fires end-to-end and `create_media_buy` no longer throws
`PRODUCT_NOT_FOUND`.

---
---

Training agent: two more storyboard wins — inventory_list_targeting + brand_rights.

- **`targeting_overlay` rename on create/get/update_media_buy**: spec field
  on both request and response is `targeting_overlay`, but the training
  agent's in-memory shape and wire I/O was `targeting`. The
  `inventory_list_targeting` storyboard asserts
  `media_buys[0].packages[0].targeting_overlay.property_list.list_id`,
  which silently never matched. Accept `targeting_overlay` on input
  (with `targeting` as a back-compat alias), emit `targeting_overlay`
  on every response path.
- **`brand_rights` acquisition fixes (3 related)**:
  - Generic `standard_monthly` pricing option alias: storyboard probes
    acquire_rights with a generic pricing_option_id the spec suggests
    but no individual offering declares. Resolve by exact match first,
    then fall back to any `flat_rate` monthly option on the offering.
  - Expired-campaign-dates rejection: storyboard sends campaign dates
    entirely in the past (2024 window); handler now returns
    `invalid_request` rather than happily issuing a license for a
    period that already ended.
  - (Previously in-flight and still part of this batch) talent filter
    fallback when brand_id doesn't exact-match, `commercial` +
    `ai_generated_image` added to available_uses, acquire_rights
    inputSchema declares `account` / `brand` / `revocation_webhook`
    (SDK was stripping them), estimated rights commitment computed
    as `CPM × estimated_impressions` so governance denial fires for
    CPM-priced rights against a small plan.

40/55 clean, 293 steps passing (was 37/55, 288).

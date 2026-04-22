---
---

Training agent: unblock the `creative_ad_server` storyboard (closes #2847).

- **`campaign_hero_video` seed.** Every new or loaded session backfills the
  `campaign_hero_video` creative referenced by the `creative_ad_server`
  storyboard. The storyboard's four stateful steps (list_creatives,
  build_creative, get_creative_delivery, report_usage) derive four different
  session keys from the declared account shapes, so a single `seed_creative`
  firing through `comply_test_controller` — the approach adcp-client#778
  will eventually auto-wire — would only land in one of them. Seeding on
  session create/load covers all four without waiting on the upstream
  runner change.
- **Capability-gated pricing on `list_creatives`.** Sellers declaring
  `creative.has_creative_library: true` quote per-creative pricing whenever
  an account is present; the SDK's request builder drops `include_pricing`
  from the wire today, so emission can't require the flag. Explicit
  `include_pricing: false` still suppresses, and creatives synced without a
  `format_id` no longer emit pricing (would have thrown on `formatId.id`).

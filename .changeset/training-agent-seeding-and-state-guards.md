---
---

Training agent: seed storyboard-hardcoded fixtures + wire a batch of
spec feature checks.

## Seeding

Conformance storyboards reference product IDs, pricing option IDs, and
format IDs by hardcoded string (rather than capturing them from our
`get_products` / `list_creative_formats` response). Aliased to real
catalog entries so the round-trip works:

- **Products**: `test-product` (universal suite), `sports_ctv_q2`
  (governance_spend_authority / governance_delivery_monitor). Clone the
  first-publisher / first-CTV-publisher product with overridden
  `product_id` and `name`.
- **Pricing options on `test-product`**: `test-pricing` and `default`
  as alias ids. `min_spend_per_package` is stripped so the small
  ($1k-$5k) budgets in universal tests don't trip the minimum-spend
  gate before they exercise the path under test.
- **Creative formats**: `video_30s`, `native_post`, `native_content`
  added as explicit format entries (referenced by
  creative_lifecycle, creative_sales_agent).
- **Buyer-supplied `media_buy_id`**: `create_media_buy` now honors an
  id in the request (e.g. `mb_acme_q2_2026_auction`,
  `mb_summer_campaign_001`) so subsequent storyboard steps can query
  by the same literal.

## Spec feature wiring

- **Past `start_time` rejection** (schema_validation): reject with
  `INVALID_REQUEST` when `start_time` is > 24h in the past (tolerance
  covers clock skew / long-running requests; the conformance vector
  uses 2020-01-01).
- **Double-cancel guard** (media_buy_state_machine): reject a second
  cancel on a media buy that's already canceled with
  `INVALID_STATE_TRANSITION`. Accept-idempotently is also valid per
  the spec; we reject for clearer state semantics.

## Results

- **37/55 clean, 281 steps passing** (was 34/55, 262).
- +3 clean storyboards, +19 passing steps.

CI non-regression floors updated in a follow-up commit.

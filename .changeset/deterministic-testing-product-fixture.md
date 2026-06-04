---
"adcontextprotocol": patch
---

Fix `deterministic_testing` media-buy phases by declaring controller seeding and adding the `test-product` / `test-pricing` fixtures referenced by its `create_media_buy` sample requests.

Without the fixture block, runners could reach the lifecycle test and fail on catalog availability (`PRODUCT_NOT_FOUND` / unavailable product) before exercising `force_media_buy_status`, `simulate_delivery`, or `simulate_budget_spend`.

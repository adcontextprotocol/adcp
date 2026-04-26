---
---

Adds `POST /api/admin/accounts/:orgId/replace-subscription` for out-of-band tier changes on existing members (custom contracts). Uses Stripe's in-place `subscriptions.update` so `stripe_subscription_id` stays the same and the agreement audit trail is preserved. Body accepts `lookup_key` or `price_id`, optional `coupon_id`, and `proration_behavior` (default `none`). Records a `subscription_replaced` audit log row with before/after state. Closes #3180.

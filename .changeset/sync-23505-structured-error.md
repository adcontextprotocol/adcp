---
---

Admin /sync now surfaces unique-constraint conflicts on stripe_subscription_id as a structured error with the conflicting org ID and name, instead of bubbling up a raw Postgres 23505. Adds GET /api/admin/accounts/by-stripe-subscription/:subId and GET /api/admin/accounts/by-stripe-customer/:customerId lookup endpoints.

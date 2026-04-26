---
---

Fix admin GET /accounts/:orgId not returning stripe_subscription_id and price_lookup_key in the subscription object. Both fields were written to the DB correctly by the webhook handler but were omitted from the response builder, causing operators to misread subscription state after cleanup operations.

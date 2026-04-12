---
---

Fix DB connection leak in org adoption path, add FOR UPDATE to org merge to prevent stripe_customer_id race condition, and wrap storyboard upsert in SAVEPOINT for resilience when migration 390 is pending.

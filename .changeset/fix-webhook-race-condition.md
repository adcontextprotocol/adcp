---
---

Fix Stripe webhook race condition where first-time membership payments silently failed to activate. Add subscription_data.metadata to checkout sessions and multi-level org resolution fallback for webhook handlers.

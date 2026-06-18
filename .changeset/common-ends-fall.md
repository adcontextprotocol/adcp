---
"adcontextprotocol": patch
---

fix(billing): resolve active membership tier drift from Stripe price lookup keys.

Active, trialing, and past-due subscriptions now treat the Stripe price lookup key as the authoritative membership-tier signal before falling back to a stored tier or amount inference. This corrects stale membership tier rows during webhook sync while preserving the existing safe default for entitled updates that arrive without resolvable price data.

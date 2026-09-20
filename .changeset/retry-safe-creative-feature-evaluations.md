---
"adcontextprotocol": minor
---

Make `get_creative_features` retry-safe and reconcilable. Requests now require
an idempotency key with a 24-hour minimum replay window, submitted and terminal
success responses carry one stable provider `evaluation_id`, and the task is
classified as consequential work so SDKs apply replay middleware. Add
deterministic conformance coverage for synchronous, asynchronous, conflicting,
and concurrent retries plus terminal pricing and consumption reconciliation.

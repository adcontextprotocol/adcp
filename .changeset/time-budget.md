---
"adcontextprotocol": minor
---

Add `time_budget` to `get_products` request and `incomplete` to response.

- `time_budget` (Duration): buyers declare how long they will commit to a request. Sellers return best-effort results within the budget and do not start processes (human approvals, expensive external queries) that cannot complete in time.
- `incomplete` (array): sellers declare what they could not finish — each entry has a `scope` (`products`, `pricing`, `forecast`, `proposals`), a human-readable `description`, and an optional `estimated_wait` duration so the buyer can decide whether to retry.
- Adds `seconds` to the Duration `unit` enum.

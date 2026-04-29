---
---

One-shot script to re-probe registry agents currently classified as `unknown` with an extended 30s timeout. Reuses the live crawler probe + write helpers; reports `{still_unknown, newly_classified by type, probe_failed, dns_failed}` so the full Problem 2 retry/backoff PR can scope from real data. See #3551.

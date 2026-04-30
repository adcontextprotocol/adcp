---
---

One-shot script to re-probe registry agents currently classified as `unknown` with an extended 30s timeout. Reuses the live crawler probe + write helpers; reports `{still_unknown, newly_classified by type, probe_failed, dns_failed, preserved_existing}` so the full Problem 2 retry/backoff PR can scope from real data. Includes per-agent timing for slow-tail visibility and a silent-corruption guard: a transient probe failure never overwrites a previously-classified snapshot row. See #3551.

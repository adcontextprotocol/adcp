---
---

feat(crawler): schedule periodic re-validation for fan-out child publishers (#4850)

`recordChildPublisherFromManager` (PR #4840) creates `publishers` rows for each child synthesized from a manager file's `publisher_properties[].publisher_domains[]` fan-out, but those rows had **no refresh schedule**. A manager-asserted child stamped `last_validated = NOW()` at fan-out time stayed at that timestamp indefinitely — manager-side revocation only propagated on the next full manager crawl, and the child's own `adagents.json` (if it exists) was never independently fetched.

**Fix.** `recordChildPublisherFromManager` now also enqueues the child into `manager_revalidation_queue` (the existing queue infrastructure from migration 471) with `next_attempt_after = NOW() + INTERVAL '24 hours'`. The existing worker (`processManagerRevalidationQueue`, drain rate 50/5min) picks them up.

**Why reuse `manager_revalidation_queue`** rather than a new table: same shape, same worker, same `crawlSingleDomain` action. The queue row says "re-validate publisher P that delegates to manager M"; that's exactly what fan-out is requesting. Migration 471's `(publisher_domain PRIMARY KEY)` is naturally idempotent.

**24h initial delay** prevents 6,800 fan-out children from immediately storming the crawler on top of the cafemedia fan-out itself. The drain rate spreads them across the following day. `ON CONFLICT DO NOTHING` preserves any existing backoff state (so a child that 404'd recently isn't reset to NOW+24h on the next fan-out — its longer backoff window stays in effect).

**What the worker does per row**: `crawlSingleDomain(child)` runs the full discovery cascade — first tries the child's own `/.well-known/adagents.json`, falls back to `ads.txt MANAGERDOMAIN`. If the child has its own file, it gets promoted to `discovery_method='direct'` with the cached blob (the divergence-detector use case from adcp-client-python#749 part 3 now has data to compare). If the child 404s, `recordFailedAdagentsFetch` records `last_http_status` and the queue row is deleted (re-enqueue happens on the next cafemedia rotation — no infinite loop).

**Tests** (extending `crawler-publisher-properties-fanout.test.ts`):
- Fan-out enqueues child with `next_attempt_after ≈ NOW + 24h`, `attempts = 0`
- Re-enqueue preserves existing backoff (idempotent)
- Self-attribute case (child == manager) skips both publishers write and queue write

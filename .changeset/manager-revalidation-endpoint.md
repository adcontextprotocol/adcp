---
---

feat(registry): manager fan-out re-validation endpoint

Closes #4200 item 5. New `POST /api/registry/manager-revalidation-request`
short-circuits the 60-minute organic crawl cycle: when a manager rotates
its `adagents.json`, ops can hit this endpoint and have every delegating
publisher enqueued immediately. Thin wrapper around
`enqueueManagerRevalidation` (which lands in #4210).

- Body: `{ manager_domain }`. Validated, lower-cased, trimmed.
- Returns `202` with `publishers_enqueued` (count of delegating publishers
  added to or refreshed in the queue). Zero when nobody delegates.
- Rate-limited via the shared `validateAndRateLimitCrawl` machinery used
  by `crawl-request` and `brand-crawl-request`. Key is namespaced
  (`manager:` prefix) so a manager-recrawl request doesn't bypass an
  in-window publisher recrawl on the same domain or vice-versa. Hourly
  per-member limit is shared.

Tests: enqueue happy path with multiple delegating publishers, zero-count
when none delegate, 400 on missing field, lower-case + trim normalization,
per-domain rate limit window.

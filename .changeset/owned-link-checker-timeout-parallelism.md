---
---

ci(links): timeout + parallelism for owned-link checker

`scripts/check-owned-links.js` had no per-fetch timeout and ran URLs serially.
When agenticadvertising.org HEAD responses were slow, the job ballooned from
~15s to 11–27 minutes (observed on bokelley/refs-resolve runs). Each fetch now
runs with a 10s `AbortSignal.timeout`, URLs are checked with 8-way concurrency,
and the workflow step has a 5-minute ceiling.

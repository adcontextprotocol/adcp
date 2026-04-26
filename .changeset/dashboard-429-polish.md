---
---

Close #2937, #2938, #2939 — the three retrospective follow-ups from PR #2933 (dashboard 429 UX).

**#2937 (P1) — coherent + accessible failure state.**
- The post-auto-retry "you've refreshed too quickly" copy is now driven by a real countdown off the second response's `Retry-After`, falling back to 60s when absent. Button stays disabled for the full window instead of re-enabling while the copy says to wait.
- Countdown container gets `role="status"`, `aria-live="polite"`, `aria-atomic="true"`. Text updates are throttled to every 10s + the final 5s + the terminal transition so screen readers aren't shouted at every tick.

**#2938 (P2) — no stale session state.**
- `autoRetriedAgents` now clears when a retry succeeds. A 9am 429 no longer taints a 5pm retry.
- New `retryInFlight` Set prevents a click-plus-countdown race from firing `retryAgentCard` twice.

**#2939 (P3) — polish.**
- `visibilitychange → visible` forces a countdown tick so background-throttled tabs don't show stuck values.
- Initial page render happens BEFORE the agent fetches. Cards appear in list order immediately in their "not yet checked" skeleton state, then hydrate in place as each worker resolves. Fixes the scrambled loading order and the "dead blank page" feel on large agent lists.
- A shared `cancellation` flag lets workers stop hammering the network when the 15s timeout fires.
- "Retrying now…" beat before auto-retry fires so the transition reads.
- Middleware: extracted `parseRetryAfterSeconds` helper that rejects 0, negatives, and non-finite values (replaces `|| undefined` which swallowed 0). Added comment noting the HTTP-date form is technically legal but express-rate-limit only emits delta-seconds.
- New `rate-limit-retry-after.test.ts` — 5 tests on the parse helper + a supertest that verifies the 429 body surfaces `retryAfter` when the header is set.

No production behavior changes beyond what's called out above. 1946 server + 631 root unit tests pass.

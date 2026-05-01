---
---

Fix broken integration tests merged in #3637 (Build Check was cancelled at merge so these landed unverified). Five issues:

- `brand-classifier-route.test.ts` and `brand-enrichment-route.test.ts`: `SUFFIX = '${pid}_${Date.now()}'` produced underscored test domains, which `enrichBrand` rejected via its `/^[a-z0-9.-]+\.[a-z]{2,}$/` regex → route returned 500. Switch separator to hyphen.
- `property-enhancement-function.test.ts`: mocked `AdAgentsManager` with `vi.fn().mockImplementation(...)`, but the production code calls `new AdAgentsManager()`. `vi.fn` returns a function, not a constructor. Replace with a real class.
- `prospect-triage-function.test.ts`: `triageEmailDomain` calls `logTriageDecision(...)` fire-and-forget (intentional — avoids blocking callers on a log write), so the test's `SELECT` raced the `INSERT`. Add a small `awaitTriageLog` poll helper instead of changing the production call to `await` (which would alter caller-visible latency).
- `member-context.ts > "renders next_event with title and days-until"` (pre-existing flake from #3621-era): `Math.floor((starts_at - now) / 86_400_000)` flipped "in 5 days" to "in 4 days" when a sub-millisecond gap accrued between the test setting `starts_at` and the formatter computing the diff. Switch to `Math.round` — also semantically correct (an event 4.7 days away should render as "in 5 days", not "in 4 days").

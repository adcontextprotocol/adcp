---
---

Closes #3774. Five sites missed by PR #3540's `'buying'`/`'sales'` inversion sweep, surfaced by Brian-style red-team of #3766.

- 3 `listAgents("buying")` filter call sites flipped to `"sales"` (`http.ts:2007`, `http.ts:8729`, `mcp-tools.ts:831`) so the crawler iterates the correct agent set without depending on the defensive re-filter at `crawler.ts:420`.
- 2 duplicated local-inference branches at `http.ts:8442` and `registry-api.ts:5802` consolidated into one shared helper `inferDiagnosticAgentType` and polarity flipped to `'sales'` — these were visible bugs in the public discovery diagnostic endpoints, returning `type: 'buying'` for any agent exposing SALES_TOOLS.
- One missing `'sales'` value in the resource-handler list at `mcp-tools.ts:2058` — pre-#3540 the only sell-side type was (incorrectly) `'buying'`, so callers couldn't filter for `agents://sales`.

12-test polarity matrix in `diagnostic-agent-type-inference.test.ts` pins the corrected behavior, including a "NEVER returns `'buying'`" invariant assertion.

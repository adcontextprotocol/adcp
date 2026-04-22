---
---

fix(addie): workspace-wide Gemini cap + enforce untrusted-input helper adoption (#2796, #2797).

Two small defensive follow-ups from the PR #2794 review cycle:

**#2796 — Workspace-wide Gemini cap.** The per-user cap (10/10min) + per-user monthly quota (5/month) bound individual abuse but didn't bound aggregate cost across a multi-member workspace. Added a `WORKSPACE_CAPS` table in `tool-rate-limiter.ts` for tools that burn a shared external budget. Started with `generate_perspective_illustration` at 50/day workspace-wide — keeps monthly Gemini spend ceiling predictable (~1500 generations/mo max). New `scope: 'workspace'` in the error response so Addie relays a clear message when the ceiling trips.

Verified existing co-author quota already works correctly: `countMonthlyGenerations` joins through `content_authors`, so any generation on a perspective counts toward every co-author's monthly 5 — they naturally share the pool. The security review's concern about "each co-author gets 5" was a misread; no DB change needed.

**#2797 — Helper adoption enforcement.** Added `server/tests/unit/untrusted-input-adoption.test.ts` which walks `server/src/` at test time, finds any file referencing `<untrusted_proposer_input>` tag strings, and fails CI if that file doesn't import from `untrusted-input.js`. Canonical module + `prompts.ts` (system-prompt consumer side) are the only allowlisted exceptions. Prevents the next author from reinventing the inline `neutralize` closure that #2794 consolidated — which would re-open the tag-escape bypass the helper defends against.

Tests: 18 rate-limiter cases (3 new for workspace cap), 1 adoption check. Total 1743 unit tests pass. Typecheck clean.

Epic #2693 remaining: #2735 (channel privacy TOCTOU), #2736 (interactive Slack approve/reject), #2789 (Postgres state for multi-instance rate limit), #2790 (per-user Anthropic token cap).

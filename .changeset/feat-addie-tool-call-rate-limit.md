---
---

feat(addie): per-user rate limit on expensive web Addie tool calls (#2755).

Slack Addie's tool-call rate is naturally bounded by Slack's API ceiling, but the web chat has no upstream limit — a logged-in member can script tool invocations at machine speed. The function-level limiter inside `proposeContentForUser` (#2767) already bounds the submission path, but other externally-facing tools could still burn Google Docs / Gemini quota or flood DB writes.

**New:** in-process per-user, per-tool + global sliding-window limiter at `server/src/addie/mcp/tool-rate-limiter.ts`. Applied at handler-creation time via `withToolRateLimit` (wrapping) or inline via `checkToolRateLimit` (for handlers that need to run logic before the rate check).

**Caps:**
- `read_google_doc`: 20 per 10 min (external Google Docs API calls)
- `attach_content_asset`: 20 per 10 min (external URL fetch, up to 50MB buffered)
- `generate_perspective_illustration`: 10 per 10 min (Gemini calls — most expensive in the surface)
- default for all other tools: 60 per 10 min (DB-read tools, conversational tools)
- global cap: 200 per 10 min across ALL tools per user (defense in depth)
- `system:*` users (newsletter pipeline, digest publisher) are exempt — automated paths legitimately run on a cadence

**Wiring:**
- `createGoogleDocsToolHandlers(userId)` gained an optional `userId` parameter. Called per-request from `createUserScopedTools` in both `handler.ts` (web) and `bolt-app.ts` (Slack) so rate limits apply per user. Boot-time registration remains as a fallback; per-request handler shadows the baseline in `claude-client`'s `allHandlers` merge.
- `attach_content_asset` handler (member-tools.ts) inlines `checkToolRateLimit` before the URL fetch begins.
- Error responses use plain strings so the LLM surfaces the message to the user with the retry window, rather than throwing and losing context.

**Tests:** 12 unit cases in `tool-rate-limiter.test.ts` cover per-tool caps, global cap, user isolation, tool isolation, `system:*` exemption, null/undefined userId handling, default cap for unknown tools, and the `withToolRateLimit` wrapper surfacing user-facing messages.

**Follow-up filed** — #2783: `generate_perspective_illustration` tool is exported but never registered. Sonnet sees it in the prompt but can't call it; rate-limit cap at 10/10min waits for that wiring.

Epic #2693 follow-ups remaining: #2735 (channel privacy TOCTOU), #2736 (interactive Slack approve/reject DMs), #2782 (wrap body in untrusted-input tags for reviewer LLM surfaces), #2783 (register illustration tools).

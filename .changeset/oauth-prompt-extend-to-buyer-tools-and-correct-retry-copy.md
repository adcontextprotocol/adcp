---
---

Extend the click-to-authorize prompt to the three remaining buyer-tool handlers
(`compare_media_kit`, `test_rfp_response`, `test_io_execution`) so an OAuth-only
seller agent stops paging `#aao-errors`. Same pattern as #4160 — detect the
typed `AuthenticationRequiredError` (or its string form on per-brief
Promise.all results), demote the log to `warn`, and surface a
`/api/oauth/agent/start` link.

Also corrects misleading copy in `run_adcp_task`'s OAuth prompt: the OAuth
callback (`agent-oauth.ts:444-457`) saves tokens and redirects but never replays
`pendingRequest`, so the previous "After you authorize, I'll automatically retry
your request" was a lie. Now reads "After you authorize, ask me to run `<task>`
again." matches the four sibling handlers.

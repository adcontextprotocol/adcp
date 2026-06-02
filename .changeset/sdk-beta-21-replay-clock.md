---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` to `8.1.0-beta.21` to consume the storyboard request-enrichment clock fix.

`3.0-compat /sales` began failing on 2026-06-01 with `create_media_buy_replay: IDEMPOTENCY_CONFLICT` (`64 clean`, floor `65`). The idempotency replay test requires the initial and replay `create_media_buy` requests to be byte-identical, but the runner's `resolveMediaBuyWindow` resolved the flight window with a per-call `Date.now()`. Once the frozen 3.0.15 fixture's `start_time` (2026-06-01) went past, the window fell to a now-relative default computed independently in each step → different canonical payload → conflict. This was branch-independent (main re-run today failed identically) and not self-healing.

`@adcp/sdk@8.1.0-beta.21` (adcp-client #2149, closing #2147) threads a stable per-run clock (`runStartMs`) into `resolveMediaBuyWindow`, so both steps enrich with the same `now` → identical window → byte-identical payload. Verified: typecheck clean and the 3.0-compat storyboard matrix returns to its floor under beta.21.

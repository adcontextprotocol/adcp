---
"adcontextprotocol": patch
---

Wire the `audience-sync` specialism storyboard (`static/compliance/source/specialisms/audience-sync/index.yaml`) with `invariants: [status.monotonic]`, closing the last gap from [adcp#2829](https://github.com/adcontextprotocol/adcp/pull/2829). `sync_audiences` responses now get the same cross-step lifecycle gating as media-buy, creative, account, si_session, catalog_item, proposal, and creative_approval.

`status.monotonic` was extended to track the audience lifecycle in [adcp-client#782](https://github.com/adcontextprotocol/adcp-client/pull/782), shipped in `@adcp/client@5.11.0`. Bump the repo's `@adcp/client` dep `^5.10.0 → ^5.11.0` to pick up the graph. Transition table is fully bidirectional across `processing / ready / too_small`, matching the "MAY transition" hedging on `audience-status.json`'s prose (landed in [adcp#2836](https://github.com/adcontextprotocol/adcp/pull/2836)).

No wire change. Any seller that was passing the `audience-sync` storyboard on the old `@adcp/client` will continue to pass unless they were emitting an off-graph status transition — which is exactly what the assertion should catch.

---
"adcontextprotocol": minor
---

Add experimental `signal_status` (`enums/signal-status.json`: `processing | ready | failed`, absent = `ready`) and `source_audience_id` (the `audience` entity from `sync_audiences`) to each `get_signals` result, so a signal agent can show that a custom or lookalike segment is still being built and which seed audience it came from. The per-signal field is named `signal_status` so it cannot collide with the response's top-level `status` discriminator, and `processing` matches `audience-status.json`. Both fields are also selectable through `get_signals.fields`, and `signal_status` is always returned when `processing` or `failed`.

The surface is experimental (`x-status: experimental`, `x-added-in: 3.3.0`). Agents declare it with `signals.features.signal_lifecycle: true` and list `signals.signal_lifecycle` in `experimental_features`; the registry row is added to the experimental status page.

Agents that emit `processing` or `failed` MUST NOT report `is_live: true` or return an `activation_key` for that signal, MUST change `wholesale_feed_version` (when returned) when a signal's `signal_status` changes, and MUST NOT return `source_audience_id` without an `account` or in a `cache_scope: "public"` response. Existing agents are unchanged.

Not included: no `build_signal` or `provision_signal` task and no seed data on the wire. The seed continues to move through `sync_audiences` with `audience_type: "lookalike_seed"`, and readiness uses the existing `get_signals` Submitted arm.

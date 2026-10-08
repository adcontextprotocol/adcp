---
"adcontextprotocol": minor
---

Add optional `signal_status` (`pending | ready | failed`, absent = `ready`) and `source_audience_id` (the `audience` entity from `sync_audiences`) to each `get_signals` result, so a signal agent can show that a custom or lookalike segment is still being built and which seed audience it came from. The per-signal field is named `signal_status` so it cannot collide with the response's top-level `status` discriminator. Both fields are also selectable through `get_signals.fields`, and `signal_status` is always returned when `pending` or `failed`.

Agents that emit `pending` or `failed` MUST NOT report `is_live: true` or return an `activation_key` for that signal, and MUST NOT return `source_audience_id` without an `account` or in a `cache_scope: "public"` response. Existing agents are unchanged.

Not included: no `build_signal` or `provision_signal` task and no seed data on the wire. The seed continues to move through `sync_audiences` with `audience_type: "lookalike_seed"`, and readiness uses the existing `get_signals` Submitted arm.

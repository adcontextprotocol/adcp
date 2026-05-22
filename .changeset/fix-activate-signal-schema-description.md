---
"adcontextprotocol": patch
---

Clarify `signal_agent_segment_id` description in `activate-signal-request.json` and `get-signals-response.json` to prevent confusion with the `signal_id` catalog object. The field accepts only the opaque string returned by `get_signals`, not the structured `SignalID` object. Also removes wrong `signal_id`/`destination`/`options` SDK-compat aliases from the training agent's `activate_signal` tool definition. Refs #3349 — the `adcp-client` scenario fix tracked separately.

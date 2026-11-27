---
"adcontextprotocol": patch
---

Clarify the `SIGNAL_NOT_FOUND` description in `enums/error-code.json` (#8956): the code covers `signal_id` only (a data-provider catalog reference), matching the not-found precedence rule in error-handling.mdx and the signal-marketplace `error_compliance` storyboard. An unresolvable `signal_agent_segment_id` (an opaque agent-internal segment ID) uses `REFERENCE_NOT_FOUND`. Description-only change; no payload validates differently.

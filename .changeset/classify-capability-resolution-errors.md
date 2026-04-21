---
---

Classify and present `@adcp/client`'s capability-resolution errors (specialism-parent-protocol-missing vs unknown-specialism) so the compliance heartbeat, Addie's `evaluate_agent_quality` / `recommend_storyboards`, and the `applicable-storyboards` REST endpoint log agent-config faults at warn and return actionable, sanitized coaching, instead of escalating them as generic "system error" failures with misleading "Unreachable" / "cache stale" messaging.

The classifier (regex-pinned to upstream wording — see adcontextprotocol/adcp-client#734 for the typed-error follow-up) is anchored at message start, forbids structural characters in captures, length-caps extracted values, sanitizes control chars and backticks, and verifies the extracted parent protocol against the local compliance index so a hostile specialism id can't smuggle a forged classification. A shared `presentCapabilityResolutionError()` formatter keeps the four call sites consistent across DB headlines (which flow into Slack DM titles), MCP tool markdown (which flows into Addie's context — fenced via `fenceAgentValue`), structured logger fields, and 422 REST envelopes (now carrying an `error_kind` discriminator).

---
"adcontextprotocol": patch
---

Backport MCP transport clarification to `v3_envelope_integrity` storyboard (3.0.x).

Adds the MCP-specific note (already present on main) explaining that `status` must
appear at the top level of `structuredContent` and is distinct from the
task-body schema (`get-adcp-capabilities-response.json`). Addresses the
confusion reported in #4832: `response_schema` passes because the task schema
intentionally omits protocol envelope fields; `envelope_field_present` for
`status` is the separate, correct enforcement layer. Also updates the `expected`
block header from "Response envelope:" to "Response envelope (all transports):"
to match main-branch wording.

The `field_absent` TODO comments for `task_status`/`response_status` are unchanged —
those await `field_absent` runner support in adcp-client (tracked separately).
The SDK gap (SDK 7.7.0 not emitting `status` on `get_adcp_capabilities`) is a
sibling-repo concern also tracked separately.

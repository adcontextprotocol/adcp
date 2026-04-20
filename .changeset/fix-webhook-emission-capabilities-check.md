---
---

Fix `webhook-emission.yaml` capability-discovery sanity check to validate a field that actually exists.

The `get_capabilities` step asserted `field_present: "operations"` on the `get_adcp_capabilities` response, but the response schema has no `operations` field — webhook-emitting operations are advertised at the transport handshake (MCP `tools/list`, A2A skills), not in the capabilities body. The runner already keys off `options.agentTools` for that, making the validation both incorrect and redundant.

Swapped to `field_present: "supported_protocols"`, which is a required top-level field in `get-adcp-capabilities-response.json`. Preserves the capabilities-body sanity check without asserting a field that was never meant to live there.

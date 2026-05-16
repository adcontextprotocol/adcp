---
---

fix(compliance): clarify MCP transport envelope binding in v3_envelope_integrity storyboard

The `v3_envelope_integrity/no_legacy_status_fields` step's narrative and
expected block did not explain where `status` lives for MCP transport.
Agent implementors seeing the `FAIL: Envelope carries the canonical v3
status field` message from the compliance runner could incorrectly
conclude the check is inapplicable to MCP agents.

Updated the step narrative and `expected` block to explicitly document that:
- For MCP agents, `status` MUST appear at the top level of `structuredContent`
  (or the `content[0].text` JSON object for pre-2025-03-26 servers).
- The extracted AdCP response IS the protocol envelope — `status` is not a
  JSON-RPC result-level field; it lives inside the content alongside
  task-specific fields.
- An agent whose MCP response passes `response_schema` validation but omits
  `status` is non-conformant: `get-adcp-capabilities-response.json` validates
  only the task-specific payload fields, not the protocol envelope fields.

Refs #3999.

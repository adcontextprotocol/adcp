---
"adcontextprotocol": minor
---

spec(envelope): normalize MCP envelope serialization (flat root, drop `payload.required`, `context` joins envelope).

`core/protocol-envelope.json` declared `required: [status, payload]` with `payload` as a nested object, but every shipping SDK (`@adcp/client`) emits the flat MCP shape — envelope fields and body fields as siblings at the root, no nested `payload:` key. Task response schemas like `media-buy/get-products-response.json` declared body fields at the root, not under `payload`. The schema's literal reading contradicted the deployed reality. Two prior triage rounds (2026-04-23, two separate sessions) converged on the same call: ratify the flat-on-the-wire behavior, add `context` as a first-class envelope field distinct from `context_id`, and drop the `payload.required` constraint.

Going with that resolution:

- **`payload.required` dropped.** `payload` becomes a documentary grouping construct, NOT a required wire key. The schema's `required:` is now empty (the `not` block rejecting legacy `task_status` / `response_status` stays). Per-transport serialization is normative in `notes`:
  - **MCP**: envelope fields and body fields are siblings at the root of the tool response. No nested `payload:` key. Matches MCP's `structuredContent` convention.
  - **A2A**: envelope fields map to transport-native task metadata (`task.status.state`, `task.contextId`, `task.id`); body fields appear inside `task.artifacts[0].parts[].DataPart` (final) or `task.status.message.parts[].DataPart` (interim).
  - **REST**: envelope fields MAY ride headers or body siblings; body fields appear at the JSON body root.
- **`context` joins the envelope as a first-class field**, `$ref` to `core/context.json`. Semantically orthogonal to `context_id`:
  - `context_id` — server-managed session identifier.
  - `context` — caller-supplied opaque echo, preserved byte-for-byte by the agent.
  - Both MAY appear on the same response; they are NOT aliases.
- **`description` rewritten** to lead with the canonical-field-set framing rather than the "wraps the payload" mental model the old text used (which encouraged the nested-`payload` misreading).

Producer and receiver rules added to `docs/building/by-layer/L0/mcp-guide.mdx` so the wire shape is normative from both ends:
- MCP tool implementations MUST emit envelope and body fields as flat siblings at root.
- MCP tool consumers MUST parse from the flat root; receivers MUST NOT require a nested `payload:` key.
- `context_id` vs `context` distinction surfaced with one-line definitions and the "both may appear" clause.

Why this resolution over "make nested canonical and migrate `@adcp/client`":
- The flat shape is what every shipping integrator has parsed against since 3.0 GA. Declaring it non-conformant before any peer SDK ships inverts the codify-deployed-behavior precedent the ecosystem already follows (OpenRTB, prebid, GAM).
- MCP's native conventions favor flat — `structuredContent` is itself a flat field; nesting `payload:` inside it is ceremonial boilerplate.
- A2A's transport-native task metadata already carries the envelope fields; nesting `payload:` would force redundant double-wrapping.

Why `context` joins as a peer of `context_id` rather than a convention:
- `get-products-response.json:147` already `$ref`s `core/context.json` for per-request echo. The convention is in use; it just never made it into the envelope doc.
- Splitting on `_id` (session identifier) vs `context` (per-request echo) is the same split A2A makes between `task.contextId` and `task.metadata`; not codifying it leaves the spec less expressive than the transports it runs over.

Files:
- `static/schemas/source/core/protocol-envelope.json` — description rewritten; `context` added; `payload` description clarified as documentary grouping; `required: [status, payload]` removed; `notes` array rewritten with normative per-transport serialization.
- `docs/building/by-layer/L0/mcp-guide.mdx` — `## MCP Response Format` section rewritten with normative producer + receiver rules and the `context_id` / `context` distinction.

Validation: `composed-schema-validation.test.cjs` (43 tests) passes against the changed envelope. Existing SDKs (`@adcp/client`) remain conformant.

Closes #2911. Unblocks adcp-client#832 (per-field envelope validation).

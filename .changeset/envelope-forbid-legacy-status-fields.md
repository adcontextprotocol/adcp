---
"adcontextprotocol": patch
---

Make the `task_status` / `response_status` prohibition from #3021 machine-enforceable at the schema level. Adds a `not: { anyOf: [{ required: [task_status] }, { required: [response_status] }] }` constraint on `protocol-envelope.json` (matching the existing idiom in `catchment.json`) so any JSON Schema validator rejects envelopes that dual-emit legacy status fields — no runner-specific primitive required. The prose MUST NOT in the envelope `status` description remains for human readers; the constraint is what validators act on. Closes #3041 at the spec layer. Runtime conformance (storyboard `field_absent` primitive + `@adcp/client` implementation) is tracked separately.

---
"adcontextprotocol": patch
---

Add `envelope_field_present` check type to the storyboard schema and update `v3-envelope-integrity.yaml` to use it for the `status` presence assertion. The new check type walks `protocol-envelope.json` rather than the step's `response_schema_ref`, eliminating the static-analysis `VERIFIER_UNREACHABLE` gap in adcp-client's storyboard-drift verifier. Requires adcp-client#1045.

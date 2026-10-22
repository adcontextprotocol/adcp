---
"adcontextprotocol": minor
---

Add the optional `request_signing.operation_sources` capability field (`mcp_tools_call`, `a2a_invocation_skill`) so a verifier can declare that it resolves the AdCP operation for `required_for` / `supported_for` / `warn_for` from A2A messages (adcp#7820), implements the operation-resolution rules including the hardening clauses, and passes the A2A conformance vectors. Absent means the verifier has not declared support: a counterparty must not infer that `required_for` is enforced over A2A. Builds on the 3.2.x security errata for GHSA-2pm6-6mc8-8xcm; the field is self-attested and informational, and buyers should sign any operation in `required_for` regardless of it.

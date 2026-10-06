---
"adcontextprotocol": minor
---

Match `request_signing.required_for` / `supported_for` / `warn_for` against the AdCP operation resolved from the request, so `required_for` now applies over A2A. A2A `SendMessage`, `SendStreamingMessage`, `message/send`, and `message/stream` resolve to the `skill` of the Message's sole DataPart; MCP `tools/call` still resolves to `params.name`; `protocol_methods_*` keep matching the JSON-RPC `method` only. Replaces the cross-namespace rule that made `required_for` unenforceable over A2A (adcp#7820).

Verifiers on an A2A interface MUST fail closed with `request_body_malformed` when a request does not resolve to exactly one operation (no or multiple DataParts, FilePart, malformed Part, duplicate keys, non-object body), and MUST use that one resolved operation for the signature gate, handler dispatch, and schema selection. Adds the optional `request_signing.operation_sources` capability field (`mcp_tools_call`, `a2a_invocation_skill`) so a verifier can declare that it implements the rules; absent means legacy, where `required_for` is not enforced over A2A. Widens the `request_body_malformed` description. Adds 25 A2A conformance vectors under `test-vectors/request-signing/a2a/` with a generator and independent test.

Migration: A2A sellers that list an operation in `required_for` begin rejecting unsigned A2A calls for it once their verifier adopts the rule. Stage the change through `warn_for` first. Verifiers that predate the rule do not enforce `required_for` over A2A; an A2A gateway that checks the decoded `skill` is the interim mitigation.

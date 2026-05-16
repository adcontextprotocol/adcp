---
"adcontextprotocol": patch
---

compliance(request-signing): add negative vector 028 — unsigned `tasks/cancel` JSON-RPC POST → `request_signature_required` (closes #4327)

Vector 028 grades the `protocol_methods_required_for` namespace introduced in #4326. The runner POSTs an unsigned `{"method":"tasks/cancel",...}` JSON-RPC body to a verifier whose capability declares `required_for: []` and `protocol_methods_required_for: ["tasks/cancel"]`. A correct verifier resolves the JSON-RPC envelope's `method` field, matches it against `protocol_methods_required_for`, and rejects with `request_signature_required`. A verifier that only consults `required_for` (the AdCP-tool namespace) would silently accept — which is the regression this vector locks out.

Gating: vector 028 is skipped when the agent doesn't declare `protocol_methods_required_for`. When the agent declares the bucket but doesn't enforce it, the vector FAILs (does not SKIP). Same shape as the existing capability-gated negative vectors.

Conformance harness addition only — no schema changes, no normative spec changes. Patch-eligible per the playbook (additive scenarios are patch-eligible). Cross-namespace match prevention (signed `tools/call` with `params.name: "tasks/cancel"` MUST NOT satisfy `protocol_methods_required_for`) is enforced server-side via the test-agent's `mcpOperationResolver` and unit-tested there; a positive-vector cross-namespace test deferred to a future PR (requires a live signing harness for the positive case).

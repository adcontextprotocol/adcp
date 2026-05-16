---
"adcontextprotocol": patch
---

chore(deps): bump `@adcp/sdk` to ^6.19.0; drop vector-028 skipVectors workaround

`@adcp/sdk@6.18.0` added the adversarial builder for conformance vector `028-unsigned-protocol-method-required` ([adcp-client#1644](https://github.com/adcontextprotocol/adcp-client/pull/1644)), which the test-agent's storyboard matrix had been skipping via `skipVectors` since vector 028 landed in [adcp#4335](https://github.com/adcontextprotocol/adcp/pull/4335). `6.19.0` ships the proposal-mode enricher fix ([adcp-client#1649](https://github.com/adcontextprotocol/adcp-client/pull/1649)) that PR #1603's over-application surfaced — required for the storyboard matrix to stay green at SDK 6.18+.

Vector 028 grades the `protocol_methods_required_for` namespace introduced in [adcp#4326](https://github.com/adcontextprotocol/adcp/pull/4326) — an unsigned `tasks/cancel` JSON-RPC POST against a verifier declaring `protocol_methods_required_for: ["tasks/cancel"]` MUST 401 with `request_signature_required`. The test-agent's strict route already enforces this; this PR closes the loop by removing the local skip so the runner actually exercises the vector.

Matrix lift (+1 step per tenant from vector 028 grading):

| Tenant            | Before | After |
|-------------------|--------|-------|
| /signals          | 58     | 59    |
| /sales            | 258    | 260   |
| /governance       | 102    | 103   |
| /creative         | 118    | 119   |
| /creative-builder | 100    | 101   |
| /brand            | 45     | 46    |

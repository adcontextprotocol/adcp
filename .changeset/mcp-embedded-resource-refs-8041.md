---
"adcontextprotocol": patch
---

Reduce MCP projected schema byte overhead by rewriting root-anchored cross-definition $refs to embedded-resource canonical $id URIs (#8041). In projected schemas with preserved document identities, cross-definition references emitted from within bundled sub-schemas previously used the root schema URL as a base (~133 bytes each). Each embedded resource already carries its own canonical $id URL (~63 bytes); rewriting to that form saves ~68 KB on the comply-test-controller projected schema and lowers the PARITY_COMPILE_LIMIT from 1,300,000 to 1,250,000 bytes. All $id values on embedded resources are preserved unchanged; fail-closed on ambiguity (no rewrite for missing, duplicate, or fragment $id targets). Scoped to compliance-protocol schemas in the canonical projection.

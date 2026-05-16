---
---

docs(conformance): document test surfaces, the SDK bridge, and the `_bridge` marker (#4593).

Adds a "Test surfaces and the storyboard loop" section to the Conformance Specification covering the two implementations of the test-surface pattern — DB-backed `seed_*` for state-local sellers (SSPs, creative agents) and the TypeScript SDK's `TestControllerBridge` for upstream-proxy sellers (DSPs, retail-media networks, signals brokers). Frames both as the same pattern, not different seller categories, and clarifies that both earn `(Spec)` while neither is what `(Sandbox)` attests. Documents the SDK's non-normative `_bridge` response marker (shipped in adcp-client#1786) and pins the underscore-prefix convention for SDK/runner-stamped metadata reserved for testing tooling. Adds a three-signal disambiguation table covering test controller availability, the `account.sandbox` flag, and `_bridge` participation. The `comply_test_controller` doc keeps a short pointer back to the canonical section, and the AAO Verified doc cross-links into it from the existing controller-relationship Note.

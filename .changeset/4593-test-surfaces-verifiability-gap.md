---
---

docs(compliance): name the verifiability gap and the role of the SDK bridge in the comply_test_controller doc (#4593).

Adds a "Test surfaces and the verifiability gap" section before the existing "Compliance testing modes" coverage. Frames the gap as universal — every seller faces it — and describes the two implementations (DB-backed `seed_*` for state-local sellers, SDK `TestControllerBridge` for upstream-proxy sellers) as different paths to the same goal, not different seller categories. Documents the non-normative `_bridge` marker (shipped in adcp-client#1786) as the response-level signal that lets runners distinguish fixture-merged content from upstream-derived content. Adds a three-axis disambiguation table covering test mode, the `account.sandbox` flag, and bridge participation.

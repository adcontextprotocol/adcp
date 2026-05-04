---
"adcontextprotocol": minor
---

Lift sole-stateful-step cascade exemption into `runner-output-contract.yaml` as normative MUST language. The spec was previously silent on what happens when the sole stateful step in a phase grades `not_applicable`, `missing_tool`, or `missing_test_controller` — causing runner divergence (the TS SDK exempts the cascade; other runners may not). Adds a top-level `cascade_rules` section with `default_cascade` and `sole_stateful_step_exemption` rules. Also bumps the contract's own `version` field from `2.0.0` → `2.1.0`.

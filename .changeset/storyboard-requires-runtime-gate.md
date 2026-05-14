---
"adcontextprotocol": minor
---

Add optional `requires` field to the storyboard schema for whole-storyboard runtime requirement gating.

Third-party runners can now declare per-storyboard requirements (`controller`, `seeded_state`, `real_wire`) that the runner evaluates at load time before executing any steps. Storyboards without the field run unchanged. The `requirement_unmet` skip reason is added to runner-output-contract.yaml to match the skip reason already emitted by `@adcp/sdk@^6.16.0` (adcp-client#1635).

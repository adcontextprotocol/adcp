---
"adcontextprotocol": minor
---

compliance: require baseline `sync_governance` registration in money-moving sales specialisms

Adds a `sync_governance` registration step to the 3.1 beta compliance flows that move or monitor spend: `sales-social`, `sales-catalog-driven`, `sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`, and the generative seller flow under `creative-generative`. The step stops at account-level governance-agent registration and does not add `check_governance` enforcement to these parent tracks.

This remains a minor beta compliance fix under the conformance-suite policy in `docs/reference/versioning.mdx`: the wire contract and `sync_governance` task already exist, and this PR aligns the beta grader with that existing baseline rather than adding a new protocol surface. Existing beta sellers claiming these money-moving specialisms must now implement `sync_governance` registration and the one-governance-agent rejection rule to remain conformant in 3.1 grading.

The `governance-aware-seller` specialism remains the opt-in claim for the full governance-check loop (`check_governance`, denial propagation, conditions, and recovery) after baseline registration.

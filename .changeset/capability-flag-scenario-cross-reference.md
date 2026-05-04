---
---

docs: add capability-flag → scenario cross-reference section to compliance-catalog.mdx

Adds a "Capability-gated scenarios" section to the compliance catalog that maps each
`get_adcp_capabilities` flag to the scenarios it controls, so adopters can understand
how a flag toggle changes their grading surface without grepping scenario YAMLs.

Also updates `sales-proposal-mode` specialism status from `stable` to `deprecated` in
the catalog table and adds a migration note, matching the enum's `x-deprecated-enum-values`
declaration.

Closes #4039.

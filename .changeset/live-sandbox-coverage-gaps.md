---
---

docs(compliance): clarify production-path sandbox partial coverage.

Documents how storyboard summaries distinguish not-selected run-mode exclusions
from selected-but-skipped coverage gaps, especially for production endpoints
that correctly omit `comply_test_controller` and therefore report zero failures
with `partial` coverage. Adds the missing universal storyboard rows for
`comply-controller-mode-gate` and `version-negotiation`, fixes the
universal-storyboard doc-parity lint to check the current verification doc
paths, and aligns `get_adcp_capabilities.compliance_testing.scenarios` with the
canonical controller scenario set so sellers can advertise deterministic
coverage without relying solely on trial dispatch.

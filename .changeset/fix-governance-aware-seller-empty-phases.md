---
---

fix(compliance): add capability_discovery phase to governance_aware_seller storyboard

The `governance_aware_seller` specialism declared `phases: []`, leaving the conformance runner with nothing to enumerate and emitting `__no_phases__` against any agent under test. It was the only specialism in `static/compliance/source/specialisms/` with an empty phases list — every peer (governance-spend-authority, signal-marketplace, brand-rights, all sales-*) declares at least a local `capability_discovery` phase even when most of the work is delegated through `requires_scenarios:`.

This adds the standard `get_adcp_capabilities` capability_discovery phase, mirroring `governance-spend-authority/index.yaml`. The four governance scenarios (`governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery`) continue to compose in via `requires_scenarios:`. Closes #2972.

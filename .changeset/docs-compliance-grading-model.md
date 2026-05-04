---
---

Add `docs/building/verification/grading-model.mdx` — a new reference page that explains the AdCP compliance grading model end-to-end.

Covers:

- **Specialism declaration** — how to declare specialisms in `get_adcp_capabilities` (`specialisms` field, kebab-case IDs, parent-protocol requirement)
- **Scenario resolution** — three-layer taxonomy (Universal → Protocol → Specialism), two-phase merge of protocol baseline and specialism `requires_scenarios`, deduplication and capability-gate application
- **Capability gates** — `requires_capability` YAML block, `capability_unsupported` skip semantics, practical example from `media_buy_seller/proposal_finalize`
- **Reading results** — accurate `overall_status` values (`passing` / `failing` / `partial`), `tracks_passed`, `steps_passed` / `steps_total`, `storyboard_id`; how to isolate a failing scenario with `storyboard run <id> --debug` and `storyboard step`
- **Invariants** — `status.monotonic` as a separate failure axis from step-level validations
- Cross-links to Validate Your Agent, Compliance Catalog, Conformance Specification, and Storyboard Authoring

Closes #4036.

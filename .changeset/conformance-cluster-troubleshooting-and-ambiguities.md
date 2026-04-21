---
---

Implementer DX docs and a storyboard note for three open conformance issues (#2605, #2607, #2608).

- New `docs/building/implementation/storyboard-troubleshooting.mdx` — failure-mode lookup for the error messages new implementers hit (PRODUCT_NOT_FOUND, missing signature challenge, envelope drift, context echo failures, capability mismatches, INVALID_STATE variants, etc.). Each section shows the raw error, explains what the runner means, and gives the fix.
- New `docs/building/implementation/known-ambiguities.mdx` — running inventory of open spec ambiguities with interim guidance: envelope shape (#2587), any_of single-branch assertions (#2605), idempotency missing-key SDK inversion (#2607), schema-optional fields asserted by vectors (#2604), check_governance conditional-approval shape (#2603), $context.* resolution (#2589), INVALID_STATE_TRANSITION canonicalization (#2588), fixture-id hardcoding (#2585). Entries are tagged Tracked/Under review/Resolved and deleted as issues close.
- `static/compliance/source/universal/idempotency.yaml` — the `missing_key` phase gains an SDK-injection caveat note in its narrative, pointing at #2607. The phase is documentation until the storyboard runner's raw-HTTP probe for this vector lands.

Both docs are wired into the Implementation Patterns nav group. Closes #2608. Progresses #2605 and #2607 by documenting the workarounds while the underlying fixes land.

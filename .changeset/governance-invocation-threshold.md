---
---

docs(governance): require `check_governance` on every spend-commit when a governance agent is configured (#2403)

Turns Embedded Human Judgment into an enforceable MUST. When a governance agent is configured on the plan, buyer agents MUST invoke `check_governance` before every spend-commit request (`create_media_buy`, `update_media_buy`, `acquire_rights`, `update_rights`, `activate_signal`, `build_creative`) — full stop. No dollar floors, no anomaly thresholds, no cold-start exemptions. Auto-approve fast-paths live inside the governance agent's own policy via the existing `budget.reallocation_threshold` and `human_review_required` fields; they are not a buyer-side skip rule.

Seller enforcement makes the MUST real: a seller receiving a spend-commit for a plan with a configured governance agent MUST require a valid, in-date `governance_context` token for the matching plan and phase, and MUST reject with `PERMISSION_DENIED` otherwise. A buyer that skips `check_governance` cannot produce a valid token.

Adds audit-log MUSTs, idempotency interaction, and extends the Embedded Human Judgment Protocol Mapping to cite the new surface.

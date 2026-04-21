---
---

storyboards: align state-machine recancel_buy phase with the normative NOT_CANCELLABLE rule landed in #2619

Follow-up to #2619 which merged before this storyboard fix could be bundled in. PR #2619 tightened the spec so that re-cancel of a `canceled` buy MUST return `NOT_CANCELLABLE` (previously the spec allowed either `INVALID_STATE` or `NOT_CANCELLABLE` under conflicting rules). The `media_buy_state_machine/terminal_state_enforcement > recancel_buy` storyboard still reflected the pre-#2619 ambiguity ("Either reject with INVALID_STATE or accept idempotently — both are valid") and would have let non-conformant sellers pass.

Aligns the storyboard to the spec:

- `expect_error: true` (was unset — allowed idempotent-accept as a valid pass)
- Expected code: `NOT_CANCELLABLE` (was INVALID_STATE-or-accept either/or)
- Added validations: `error_code` check + context echo (mirrors the `invalid_transitions.yaml > second_cancel` pattern that was already correct)

Narrative updated to reflect the carve-out: cancellation-specific code takes precedence over the generic terminal-state rule; idempotent acceptance is not conformant for this case.

No spec change. No other storyboards needed updates — `invalid_transitions.yaml > second_cancel` was already correct.

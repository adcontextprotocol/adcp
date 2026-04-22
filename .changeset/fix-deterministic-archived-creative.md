---
---

Storyboard: `deterministic_testing.force_creative_rejected` — split
into a `sync_fresh_creative_for_rejection` step + the rejection force.

The prior shape reused `$context.creative_id` from the previous phase,
where the creative was forced to `archived` (terminal). The rejection
step then expected `success: true` for `archived → rejected`, which
any conformant creative-state machine rejects — directly contradicting
the `invalid_creative_transition` step earlier in the same phase that
asserts archived is terminal.

Fix: sync a fresh creative first (captures
`$context.fresh_creative_id`), then run the rejection against the
fresh id (from `processing`), which is a valid transition per the
creative-state machine.

Closes #2851.

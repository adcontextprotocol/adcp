---
"adcontextprotocol": patch
---

compliance(storyboard): fix proposal-mode fixture authoring in `sales_proposal_mode` and `media_buy_seller/proposal_finalize`

Two pre-existing storyboard authoring issues, surfaced by `@adcp/sdk` PR #1603 (which made `create_media_buy` actually exercise proposal-mode end-to-end instead of silently sending `packages` regardless):

1. **`sales_proposal_mode`** authored `proposal_id: "balanced_reach_q2"` as a literal in two places (refine step + create_media_buy step). The training-agent's seed proposals don't include that id (it seeds `pinnacle_cross_channel`, `viewpoint_multi_screen`, `sparq_social_amplification`, `novamind_ai_audience`). Switched both to `$context.proposal_id` so the storyboard dynamically references whichever proposal the brief returned, matching the pattern `media_buy_seller/proposal_finalize` already uses.

2. **Both storyboards** now include `io_acceptance` on the `create_media_buy` fixture. AdCP 3.0+ proposals with guaranteed inventory carry an `insertion_order` with `requires_signature: true` after finalization; sellers reject `create_media_buy` against such proposals without `io_acceptance`. The finalize step's `context_outputs` captures `proposals[0].insertion_order.io_id`, and the create_media_buy step references it via `$context.io_id`.

3. **`sales_proposal_mode`** previously jumped straight from refine to create_media_buy, which kept the proposal in `draft` status. Added a `finalize_proposal` phase between them (matching the pattern in `media_buy_seller/proposal_finalize`) so the proposal transitions to `committed` before acceptance.

Forward-compatible with both pre-#1603 and post-#1603 SDK behavior — all six tenant matrix runs pass against both. /sales lifts from 258 → 259 steps (the new finalize step counts).

Patch-eligible per the conformance-additive rule (additive scenarios / fixture corrections that bring storyboards into alignment with the spec's own normative proposal-lifecycle).

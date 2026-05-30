---
"adcontextprotocol": minor
---

Clarify proposal lifecycle semantics and mark measurement catalog discovery experimental for 3.1.

Proposal updates:
- `proposal_status` is the per-proposal source of truth for whether finalization is required before `create_media_buy`.
- `finalize` is seller commitment to firm pricing/terms/hold, not buyer acceptance.
- `create_media_buy(proposal_id)` is buyer acceptance/execution of a committed proposal.
- `supports_proposals` is a conformance grading declaration, not buyer routing logic for an individual returned proposal.
- `allowed_actions[]` / `available_actions[]` remain scoped to media-buy mutations; proposal lifecycle is not modeled as a proposal-level action list.
- `requires_proposal` is removed from media-buy action modes before 3.1 GA, replacing the rc-shipped enum with `REQUOTE_REQUIRED` recovery when an update exceeds the current quoted envelope. 3.1 does not define an amendment-quote artifact for `update_media_buy`.

Measurement updates:
- `measurement` capability block is marked `x-status: experimental`.
- Agents implementing the measurement catalog declare `measurement.core` in `experimental_features`.
- Docs describe measurement vendor catalog discovery as experimental while the task surface and compliance baseline remain unfrozen.

---
---

**conformance**: chain `proposal_id` through `media_buy_seller/proposal_finalize` storyboard.

The `brief_with_proposals` step now captures `proposals[0].proposal_id` via `context_outputs`, and the downstream `refine_proposal` / `finalize_proposal` / `accept_proposal` steps reference it as `$context.proposal_id` instead of the hardcoded placeholder `balanced_reach_q2`. Sellers that mint runtime `proposal_id` values (uuids, db rowids) can now pass the full lifecycle — previously the literal placeholder reached the wire and 404'd against any stateful upstream. Closes #4086.

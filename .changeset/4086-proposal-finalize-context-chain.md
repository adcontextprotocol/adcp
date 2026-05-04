---
"adcontextprotocol": patch
---

Fix proposal_id context chaining in proposal_finalize and sales-proposal-mode storyboards.

The `media_buy_seller/proposal_finalize` and `sales-proposal-mode` storyboards were sending
the static placeholder `"balanced_reach_q2"` as `proposal_id` in `refine_proposal`,
`finalize_proposal`, and `accept_proposal` steps instead of threading the seller-minted
value from `brief_with_proposals`. Proposal-mode sellers with runtime-generated IDs
(UUIDs, DB rowids) received 404s or wire-shape failures on those steps.

Changes:
- Add `context_outputs` on `brief_with_proposals/get_products_brief` capturing
  `proposals[0].proposal_id` into the context accumulator.
- Replace `"balanced_reach_q2"` with `"$context.proposal_id"` in `refine_proposal`,
  `finalize_proposal`, and `accept_proposal` steps of both storyboards.
- Add `check: field_present` validation for `proposal_id` echo on `create_media_buy`
  response in `proposal_finalize`.
- Add optional `proposal_id` field to `CreateMediaBuySuccess` schema to document the
  echo contract and support the storyboard validation.

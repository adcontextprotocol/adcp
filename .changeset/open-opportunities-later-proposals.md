---
"adcontextprotocol": minor
---

Experimental open opportunities (`media_buy.open_opportunities`, RFC #8096). A buyer can keep an opportunity open after the first response and let a seller send later proposals, with consent and limits the buyer controls.

- `opportunity.later_proposals` (`accepted`, `until`, `max_count`, `min_interval`) on the shared `OpportunityContext`. No consent unless given; never inferred from an absent `response_deadline`, which keeps its meaning. The seller echoes the recorded consent and computed `window_ends_at` (`core/later-proposals-state.json`) on the `request_proposals` response.
- Later proposals are draft-only `new_media_buy` proposals with `opportunity_id`, `expires_at`, and a `later_reason`, announced with the new account-anchored, identifiers-only `proposal.created` notification (`core/proposal-created-webhook.json`) on account `notification_configs[]`, never on a task's `push_notification_config`. Sellers on the account change feed also record `proposal` changes with the new `list_proposals` repair task, for 3.3 callers only.
- New `list_proposals` task: an account-scoped read filtered by opportunity, proposal, or disposition that returns each snapshot unchanged beside a seller-tracked `disposition` (`available`, `accepted`, `declined`, `expired`, `withdrawn`), its `origin`, and each opportunity's state.
- `accept_proposal` and `buy_products` accept an explicit `opportunity.status: "open"` to keep sourcing after a purchase; omission still infers `accepted_with_seller` closure. `later_proposals` is valid on those tasks only with `status: "open"` and never on `create_media_buy`. `decline_proposals` accepts an empty `declines` array with an `opportunity` update, to close or withdraw consent without declining a proposal.
- For sellers that advertise the feature, re-sending `request_proposals` with a held `opportunity_id` replaces the stored brief, and a closed opportunity is never reopened (`INVALID_REQUEST`). Other sellers keep 3.2 behavior.
- `media_buy.open_opportunities` capability block with separately advertised `list_proposals`, `keep_open_after_purchase`, and `later_proposals` (with required `max_open_duration`); `list_proposals` added to `lifecycle_tools`.
- `comply_test_controller` scenario `simulate_later_proposal` with an `opportunity_id` param.

Buyers MUST NOT use a part the seller does not advertise; 3.2 sellers reject the new values. Certification: the proposal-lifecycle module may want a later-proposal lesson once the surface graduates.

---
"adcontextprotocol": patch
---

`media_buy_seller/total_budget_redistribution` now sends the currency the buy
was actually committed in instead of a hardcoded `USD`.

The scenario grades `total_budget` redistribution, not currency selection
(that is `media_buy_seller/pricing_currency_filter`). Both of its
`update_media_buy` requests wrote `total_budget.currency: "USD"`, so a seller
whose buy is denominated in another currency was failed for correctly
rejecting an update that would have redenominated it, and the read-back then
graded the consequentially unchanged total as wrong too.

A new `read_committed_currency` step captures `media_buys[0].currency` and
both updates send `$context.media_buy_currency`; the post-update read-back
asserts the redistribution did not redenominate the buy. `get_media_buys` is
the source because `media_buys[].currency` is the only required carrier of a
committed buy's currency — `create_media_buy` and `update_media_buy` both
leave `currency` optional, so capturing from the create response would have
traded a `VALIDATION_ERROR` for a `capture_path_not_resolvable` against a
seller that omits it.

Two supporting corrections. `create_fixed_buy` now captures its revision as
`created_revision`: `get_media_buys` writes `revision` by convention and
convention extraction runs before explicit captures, so the new read would
otherwise have overwritten the revision `create_media_buy` returned.
`reject_total_with_packages` becomes `stateful: true` and its phase declares
`depends_on: [setup]`: `expect_error` steps are not skipped on unresolved
`$context` substitution, so a failed capture would otherwise put the raw token
on the wire and let the step pass on the seller's rejection of that rather
than on the inconsistent package sum it exists to grade. `depends_on` keeps
the probe graded when only the redistribute phase trips.

The seeded USD rate card is unchanged; the scenario simply no longer assumes
it was the rate card that priced the buy. No currency capability gate is added.

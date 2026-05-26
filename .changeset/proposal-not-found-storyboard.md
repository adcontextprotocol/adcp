---
---

Add compliance storyboard for PROPOSAL_NOT_FOUND and PROPOSAL_EXPIRED error codes (#4935).
New scenario `media_buy_seller/proposal_not_found_errors` forces both error codes on the
get_products refine path and the create_media_buy path using deterministic sentinel IDs.
Closes the conformance gap where sellers could return generic NOT_FOUND and still pass
the happy-path proposal storyboards.

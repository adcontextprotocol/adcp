---
"adcontextprotocol": minor
---

Add the `PROPOSAL_TERMS_CHANGED` error code (#9168). A seller returns it when an `accept_proposal` request's `proposal_terms_digest` does not match the committed proposal's current `terms_digest`, including a proposal already accepted under a different digest. Nothing is accepted. Recovery is `correctable`: the buyer re-reads the proposal; if it is `accepted`, it finds the existing MediaBuy through `get_media_buys`, and otherwise accepts the current terms with the current digest and a fresh `idempotency_key`. `IDEMPOTENCY_CONFLICT` and the proposal-state codes take precedence.

`proposal_terms_digest` and the `accept_proposal` page now say that a mismatch MUST be refused with nothing created, amended, or cancelled, and SHOULD use `PROPOSAL_TERMS_CHANGED` with `error.field` set to `proposal_terms_digest`. Sellers on releases before 3.3 may use another code, so buyers act on `recovery` and `field`. `error.code` is an open string, so no payload validates differently.

The `media_buy_seller/compact_product_lifecycle` storyboard (1.3.0) attempts acceptance with a mismatched digest before the real acceptance. Any refusal passes, and the acceptance that follows proves the proposal wasn't accepted. The code, a `correctable` recovery, and `field: proposal_terms_digest` are advisory checks, since they are SHOULD.

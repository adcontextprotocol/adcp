---
"adcontextprotocol": minor
---

Add optional `name` to `buy_products` and `accept_proposal` requests, and to the shared `media-buy-commitment-response.json` success branch, matching the human-readable trafficking-UI display label `create_media_buy`/`update_media_buy` already carry. The 3.2 compact lifecycle (#6115) merged one day before `name` was added to the orchestrated tools (#6573) and was never updated to match — buyers on the compact path had no way to set the label without a follow-up `control_media_buy` revision. `accept_proposal` additionally documents that the field is not a covered component of `proposal_terms_digest`, and that sellers MAY seed the name from the accepted proposal's own `name` when the request omits one. Closes #7536.

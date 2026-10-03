---
"adcontextprotocol": minor
---

spec(accounts): discovery and negotiation tasks never provision an account. Building on the "Account references before provisioning" clarification, a lazy-provisioning seller now provisions only on a provisioning task: one that commits spend or creates account-owned resources, such as `create_media_buy`, `buy_products`, `accept_proposal`, `sync_*`, or `activate_signal`. `get_products`, `list_products`, `get_signals`, `request_proposals`, `refine_proposals`, and `decline_proposals` MUST NOT create or activate an account, or accept the seller's default terms on its behalf.

A seller that lazily provisions instead of exposing `sync_accounts` MAY answer a discovery task for the account it would create, without creating it. Every other unresolved `account` returns `ACCOUNT_NOT_FOUND`.

This narrows the earlier "first account-scoped request" wording, under which a seller that provisioned on `get_products` was conformant, so it is classified `minor`. The wire result is unchanged, because a lazy-provisioning seller may still answer discovery.

Adds the advisory storyboard `media_buy_seller/unprovisioned_account_reference`, whose checks become required at runner capability `14.1.0`.

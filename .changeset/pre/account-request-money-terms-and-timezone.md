---
"adcontextprotocol": minor
---

Account requests (experimental): resolved requests carry money terms, money changes say when they take effect, and timezone changeability is consistent.

- A request that resolves as `matched` or `created` now MUST carry `account`, with the account's `billing`, `billing_entity` (without write-only fields) and `payment_terms`, because they can differ from the terms requested.
- A request that resolves as `updated` and changed `billing`, `billing_entity` or `payment_terms` carries `effective_at`, when the new money terms take effect.
- A change request that resolves as `created` (a separate account) carries `not_carried_over`: the account-level configurations the new account doesn't have.
- `currency` and `timezone` change through `request_account` only on sellers that list them in `account.requests.changeable_attributes`; a seller that changes timezone MUST list it. `request_account` and `sync_principal` docs now agree.

---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): deterministic resolution and admission, and fewer versions at agency scale.

- **Admission under `max_accounts`** is now normative. It is sticky, ordered by the account's `authorization.authorized_at` and then `account_id` in byte order, and the same for every subscription of a principal. Accounts without covered buys count, so admission is computable from `list_accounts`.
- **Resolution** is per package, made when a (buy, version) pair first resolves, and fixed until the resolved offering is withdrawn. A newly added offering never re-resolves it.
- **Billing subscriptions MUST use `match: exact` with `dimensions`** (schema-enforced).
- **`destination_overrides[]`** routes accounts, by `account_ids` or `operator_domains`, to other destinations inside one subscription.
- **Membership edits apply in place.** Adding or removing `account_ids`, and changing `exclude_account_ids`, no longer need a new `subscription_version`. Each edit is recorded per account as an `excluded_by_buyer` exception interval.
- **Bounded, paged readback.** `prior_versions` lists the 16 newest inline, and the account lists stay capped at 1,000. Each list carries a total count, and `get_principal` gains a `reporting_subscription_page` request for the rest.
- **Several pacing or analytics subscriptions** may apply to one account and purpose. Where two resolve the same offering for a package, the lower `subscription_id` owes it and the other records a package-level `overridden` exception. Billing stays one per account at a scope level.

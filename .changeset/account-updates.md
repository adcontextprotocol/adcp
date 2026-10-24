---
"adcontextprotocol": minor
---

Add experimental account updates under the new feature id `account.updates` (#8280, #8442).

`update_account` changes settings or identity on one existing account, with the semantics of a `sync_accounts` settings-update entry. It takes `account` (preferably `account_id`), `revision`, `operator_identity`, `destination_billing_entity`, `brand_identity`, `billing_entity`, `payment_terms`, `notification_configs`, and `dry_run`; durable reporting delivery stays on `sync_accounts`. It returns the account after the call and an `outcome` of `applied`, `pending_approval`, `unchanged`, or `previewed`; a stale revision fails with `CONFLICT`, and an identity collision with `ACCOUNT_IDENTITY_CONFLICT`. Sellers declare it in `account.updates` on `get_adcp_capabilities`.

Brand countries reconciliation: `brand_identity`, the complete desired BrandKey, is accepted on `sync_accounts` settings-update entries and on `update_account`. Only `countries` may differ from the current brand, and `revision` is required. It is gated by a new `brand_countries` value in `account.identity_updates.supported_changes`. The seller preserves `account_id` and history, rejects collisions without merging, may apply, hold, or reject the change, and tombstones the former key (`ACCOUNT_MOVED`).

`core/account-identity-change.json` and `core/account-identity-change-preview.json` gain an optional `requested_brand_identity`, and a pending change gains an optional `pending_action`. `requested_operator_identity` stays required: it carries the current operator identity when only the brand changes, so 3.2 consumers keep working.

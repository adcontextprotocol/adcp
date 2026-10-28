---
"adcontextprotocol": minor
---

Make `request_account` the single account write and deprecate `sync_accounts` (#8543, Part A).

- `request_account` changes an existing account as well as opening one. With `account_id` and other fields, each field is a requested change: the brand's `countries` (with a matching `domain` and `brand_id`), `operator_unit`, `billing`, `billing_entity`, and `payment_terms`. `currency` and `timezone` may be refused, and `sandbox` never changes. A new `revision` guards the change (`CONFLICT` when stale). It is required when the change touches `billing`, `billing_entity`, or `payment_terms`, and optional otherwise. A change resolves with the new `resolution: updated`, and the request record gains an optional `account` snapshot on `resolved`. A change the seller must approve goes `in_review` with a pending action, and the account keeps its current attributes until the request resolves.
- `list_accounts` reads requests: new optional `include_requests` and `request_ids` return `account_requests[]` beside `accounts[]`. The unreleased `get_account_requests` task is removed. `account.requests.read_task` is now `list_accounts`.
- `sync_accounts` is superseded (`x-deprecated-in: 3.3.0`, `x-superseded-by: request_account, list_accounts, sync_principal`). Sellers keep serving it throughout 3.x, and it is removed in 4.0. Until then, an entry that carries only `notification_configs` and/or `reporting_delivery_configs` is a subscription write: the seller MUST NOT provision, verify brand or operator authorization, run account review, or change account attributes for it.

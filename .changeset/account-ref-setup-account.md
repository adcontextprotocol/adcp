---
"adcontextprotocol": minor
---

Replace account_id with account reference, add account_scope to sync_accounts.

- Add `account-ref.json`: union type accepting `{ account_id }` or `{ house, brand_id?, operator? }`
- Add `account_resolution` capability: `["account_id", "natural_key"]`
- Make `account` required on get_products, create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
- Make `account` required per record on report_usage
- Remove `required_for_products` capability (account is always required for get_products)
- Add `account_scope` to account and sync_accounts response schemas
- Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes

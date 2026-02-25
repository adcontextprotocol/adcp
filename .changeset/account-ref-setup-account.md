---
"adcontextprotocol": minor
---

Replace account_id with account reference, restructure account model.

- Add `account-ref.json`: union type accepting `{ account_id }` or `{ brand, operator }`
- Use `brand-ref.json` (domain + brand_id) instead of flat house + brand_id in account schemas
- Make `operator` required everywhere (brand sets operator to its own domain when operating its own seat)
- Add `account_resolution` capability: `["explicit_account_id", "implicit_from_sync"]`
- Simplify billing to `operator` or `agent` only (brand-as-operator when brand pays directly)
- Billing is accept-or-reject — sellers cannot silently remap billing
- Make `account` required on get_products, create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
- Make `account` required per record on report_usage
- Remove `required_for_products` capability (account is always required for get_products)
- Add `account_scope` to account and sync_accounts response schemas
- Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes

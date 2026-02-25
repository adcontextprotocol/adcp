---
"adcontextprotocol": minor
---

Replace account_id with account reference, restructure account model.

- Add `account-ref.json`: union type accepting `{ account_id }` or `{ brand, operator }`
- Use `brand-ref.json` (domain + brand_id) instead of flat house + brand_id in account schemas
- Make `operator` required everywhere (brand sets operator to its own domain when operating its own seat)
- Add `account_resolution` capability (string: `explicit_account_id` or `implicit_from_sync`)
- Simplify billing to `operator` or `agent` only (brand-as-operator when brand pays directly)
- **Breaking**: `billing` is now required in `sync_accounts` request (previously optional). Existing callers that omit `billing` will receive validation errors. Billing is accept-or-reject — sellers cannot silently remap billing.
- Make `account` required on create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
- Make `account` required per record on report_usage
- `sync_accounts` no longer returns `account_id` — the seller manages account identifiers internally. Buyers discover IDs via `list_accounts` (explicit model) or use natural keys (implicit model).
- Make `account_id` required in `account.json` (remove conditional if/then — the schema is only used in seller responses where the seller always has an ID)
- Add `account_scope` to account and sync_accounts response schemas
- Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes
- Add `get_account_financials` task for operator-billed account financial status

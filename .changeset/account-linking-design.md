---
"adcontextprotocol": major
---

Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

BREAKING: `account_id` is now required on `create_media_buy`. Existing callers must provide an account_id obtained via `sync_accounts` or `list_accounts`.

- `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
- `authorized_operators` in brand.json: Brand declares which operators can represent them
- Account capabilities in `get_adcp_capabilities`: require_operator_auth, supported_billing, required_for_products
- Three-party billing model: brand, operator, agent
- Account status lifecycle: active, pending_approval, payment_required, suspended, closed

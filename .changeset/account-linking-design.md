---
"adcontextprotocol": minor
---

Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

`account_id` is optional on `create_media_buy`. Single-account agents can omit it; multi-account agents must provide it.

- `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
- `authorized_operators` in brand.json: Brand declares which operators can represent them
- Account capabilities in `get_adcp_capabilities`: require_operator_auth, supported_billing, required_for_products
- Three-party billing model: brand, operator, agent
- Account status lifecycle: active, pending_approval, payment_required, suspended, closed

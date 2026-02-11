---
"adcontextprotocol": minor
---

Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

- `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
- `authorized_operators` in brand.json: Brand declares which operators can represent them
- Account capabilities in `get_adcp_capabilities`: setup_modes, supported_billing, required_for_products
- Three-party billing model: brand, operator, agent
- Account status lifecycle: active, pending_approval, pending_authorization, suspended, closed

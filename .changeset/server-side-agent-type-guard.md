---
---

Prevent new misclassifications of registered agents by deriving `agent.type` server-side from the capability snapshot rather than trusting the client payload.

`PUT /api/me/member-profile`, the POST create path, and the admin override at `PUT /api/admin/member-profiles/:id` now run a `resolveAgentTypes()` helper that (a) overrides any client-supplied `type` with `agent_capabilities_snapshot.inferred_type` whenever a probed snapshot exists for the URL, and (b) drops out-of-enum values like `'buyer'` / `'seller'` (legacy dev-seed strings) instead of letting them propagate.

Hardening the storage layer too: `MemberDatabase.normalizeAgentConfig` now validates `type` via `isValidAgentType` before deserializing, and `AgentConfig.type` is tightened from `AgentType | 'buyer'` to just `AgentType`. Hard-coded defaults are corrected: `dev-setup.ts` Training Agent → `'sales'`, Acme Buyer/Seller agents → `'buying'` / `'sales'`, Acme offerings → `sales_agent` (not the invalid `seller_agent`); `adcp-tools.ts` OAuth-context creation defaults to `'unknown'` (the discovery probe sets the real value later).

Refs #3495. Stacks on top of #3496 (the server-side inference returns `'sales'` for sales agents only after that PR's fix to `inferTypeFromProfile`).

---
---

chore(dashboard): remove dead platform_type UI (closes #2811)

Migration [409](https://github.com/adcontextprotocol/adcp/blob/main/server/src/db/migrations/409_drop_platform_type.sql) dropped `platform_type` from `agent_registry_metadata` when `@adcp/client` 5.1.0 replaced the concept with specialisms. The dashboard `buildConnectForm` still rendered three `<select name="platform_type*">` selects (one per auth-type field group) and the save handlers still POSTed `body.platform_type` — the server silently ignored the field.

Deletions from `server/public/dashboard-agents.html`:

- Three `<label>Platform type<select …>` rows inside `buildConnectForm` (bearer/basic, oauth, oauth_client_credentials variants).
- The 15-entry `platformTypes` array and its `platformTypeOptions` join in `renderAgentsSection`.
- `buildConnectForm`'s `platformTypeOptions` parameter. Both call sites updated.
- `platformType` reads + `body.platform_type = …` assignments in the bearer/basic save handler and the OAuth authorize flow's "context already exists" branch.
- The OAuth authorize flow's dead second `PUT /connect` that was sent "to save platform type even if context already exists" — it's now a no-op.

Post-delete: `buildConnectForm(escapedUrl, agentContextId)` — cleaner signature, no cross-render dependency on `platformTypeOptions`. Save handlers POST only the fields the server actually reads. Agent specialism discovery (via `get_adcp_capabilities`) replaces the classification the operator used to hand-set.

Verified: all 16 isolated form tests still pass on the updated signature. Typecheck + HTML JS parse both clean.

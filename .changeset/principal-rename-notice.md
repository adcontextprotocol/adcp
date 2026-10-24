---
"adcontextprotocol": minor
---

Publish an experimental breaking-change notice for the principal layer (`protocol.principal`, #8280). No earlier than the first minor release after December 7, 2026, and only for callers pinned at that release, `sync_principal` / `get_principal` become `sync_buyer_agent_config` / `get_buyer_agent_config`. The related names follow: `adcp.buyer_agent_config`, `buyer_agent_config.changed`, `protocol.buyer_agent_config`, and `buyer_agent_id`. `principal_kind` is removed, and `sync_agent_notification_configs` is deprecated in favor of `sync_buyer_agent_config` `notification_configs`. The mapping, before/after examples, and timeline are in `docs/reference/migration/principal-to-buyer-agent-config.mdx`.

Nothing changes on the wire in 3.3. A principal is now defined as the buyer agent as the seller has bound it, and nothing else. `principal_kind` on `get_principal` and `sync_principal` responses, `expected_principal_kind` on `sync_principal` requests, and `enums/principal-kind.json` are marked deprecated (`x-deprecated-in: 3.3.0`). The glossary, `sync_principal`, `get_principal`, and the buyer agent setup walkthrough drop the material on persons and operator logins as principals.

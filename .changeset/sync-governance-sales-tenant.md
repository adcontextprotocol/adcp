---
"adcontextprotocol": patch
---

Wire `sync_governance` onto the reference agent's `/sales` (`media_buy_seller`) tenant. Every media_buy_seller specialism (sales-guaranteed, sales-non-guaranteed, sales-broadcast-tv, sales-catalog-driven, sales-social, governance-aware-seller) lists `sync_governance` in `required_tools` and calls it against `/sales`, but the tool was only registered on `/signals` — so the "Register governance agents" step failed with `MCP error -32602: Tool sync_governance not found`. The handler is tenant-agnostic; this registers it via `customTools` on `/sales` (mirroring `/signals`) and updates the tool catalog so the drift test reflects both tenants.

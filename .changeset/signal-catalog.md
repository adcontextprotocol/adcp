---
"adcontextprotocol": minor
---

Add Signal Catalog feature for data providers

Data providers (Polk, Experian, Acxiom, etc.) can now publish signal catalogs via `adagents.json`, enabling AI agents to discover, verify authorization, and activate their signals—without custom integrations.

**Why this matters:**
- **Discovery**: AI agents can find signals via natural language or structured lookup
- **Authorization verification**: Buyers can verify a signals agent is authorized by checking the data provider's domain directly
- **Typed targeting**: Signal definitions include value types (binary, categorical, numeric) so agents construct correct targeting expressions
- **Scalable partnerships**: Authorize agents once; as you add signals, authorized agents automatically have access

**New schemas:**
- `signal-id.json` - Universal signal identifier with `source` discriminator: `catalog` (data_provider_domain + id, verifiable) or `agent` (agent_url + id, trust-based)
- `signal-definition.json` - Signal spec in data provider's catalog
- `signal-targeting.json` - Discriminated union for targeting by value_type
- `signal-category.json` / `signal-value-type.json` / `signal-source.json` - Enums

**Modified schemas:**
- `adagents.json` - Added `signals` array, `signal_tags`, and signal authorization types
- `get-signals-request.json` / `get-signals-response.json` - Added `signal_ids` lookup and structured responses
- `product.json` - Added `signal_targeting_allowed` flag

**Server updates:**
- `AdAgentsManager` - Full signals validation, creation, and authorization verification
- AAO Registry - Data providers as first-class member type with federated discovery

See [Data Provider Guide](/docs/signals/data-providers) for implementation details.

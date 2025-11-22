---
"adcontextprotocol": minor
---

Add AdCP extension schema for agent card capability discovery

Introduces a standardized extension schema that AdCP agents can include in their agent cards to declare protocol version and supported domains programmatically.

**New schema:** `adcp-extension.json`

**Usage:**
- A2A agents: Include `extensions.adcp` in `/.well-known/agent.json`
- MCP servers: Will include `extensions.adcp` in server info once MCP adds server card support

**Extension structure:**
```json
{
  "extensions": {
    "adcp": {
      "adcp_version": "2.4.0",
      "protocols_supported": ["media_buy", "creative", "signals"]
    }
  }
}
```

**Benefits:**
- Clients can discover AdCP capabilities without test calls
- Agents declare which domains they implement
- Version information enables compatibility checks
- Same extension works for both A2A and MCP protocols

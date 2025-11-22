---
"adcontextprotocol": patch
---

Fix: Rename `destinations` field to `deployments` in all signal request schemas for terminology consistency.

This change standardizes the field name to use "deployments" throughout both requests and responses, creating a simpler mental model where everything uses consistent "deployment" terminology.

**What changed:**
- `get_signals` request: `deliver_to.destinations` → `deliver_to.deployments`
- `activate_signal` request: `destinations` → `deployments`

**Migration guide:**

**Before:**
```json
{
  "signal_spec": "High-income households",
  "deliver_to": {
    "destinations": [{
      "type": "platform",
      "platform": "the-trade-desk"
    }],
    "countries": ["US"]
  }
}
```

**After:**
```json
{
  "signal_spec": "High-income households",
  "deliver_to": {
    "deployments": [{
      "type": "platform",
      "platform": "the-trade-desk"
    }],
    "countries": ["US"]
  }
}
```

The `Destination` schema itself remains unchanged - only the field name in requests has been renamed to match the response field name (`deployments`).

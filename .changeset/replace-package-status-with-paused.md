---
"adcontextprotocol": minor
---

Replace package `status` enum with `paused` boolean for clearer semantics.

**Breaking Changes:**
- Removed `status` field from Package schema (was `"draft" | "active" | "paused" | "completed"`)
- Added `paused: boolean` field to Package schema (buyer-controlled pause state)
- Changed `update_media_buy` request: `active: boolean` → `paused: boolean`
- Added `delivery_status` field to `get_media_buy_delivery` per-package metrics (system-reported operational state)

**Rationale:**
The previous `status` enum conflated buyer control (pause/resume) with system state (lifecycle phase). This created confusion about:
- Who sets the field (buyer vs. system)
- What transitions are valid
- Whether "paused" can be a final state

**New Design:**
- **`paused: boolean`** (in Package object) - Buyer-controlled pause state
  - `false` = package should deliver (default)
  - `true` = package should not deliver, regardless of budget/dates
  - Can be a final state (buyer pauses and never resumes)

- **`delivery_status: string`** (in delivery reporting) - System-reported operational state
  - Shows actual delivery state: `"delivering"`, `"completed"`, `"budget_exhausted"`, etc.
  - Reflects system reality, not buyer intent

**Migration Guide:**

Before:
```json
{
  "packages": [{
    "package_id": "pkg_123",
    "status": "active"
  }]
}
```

After:
```json
{
  "packages": [{
    "package_id": "pkg_123",
    "paused": false
  }]
}
```

Before (update request):
```json
{
  "packages": [{
    "package_id": "pkg_123",
    "active": false  // Pause package
  }]
}
```

After (update request):
```json
{
  "packages": [{
    "package_id": "pkg_123",
    "paused": true  // Pause package
  }]
}
```

**Benefits:**
- Clear separation of buyer control vs. system state
- Simpler boolean semantics (paused or not)
- Eliminates unused "draft" state
- Removes ambiguity about who controls the field
- Delivery reporting shows actual operational state separately

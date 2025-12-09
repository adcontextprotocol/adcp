---
"adcontextprotocol": patch
---

Redesign how AdCP handles push notifications for async tasks. The key change is separating **what data is sent** (AdCP's responsibility) from **how it's delivered** (protocol's responsibility).

**Renamed:**

- `webhook-payload.json` → `mcp-webhook-payload.json` (clarifies this envelope is MCP-specific)

**Created:**

- `async-response-data.json` - Union schema for all async response data types
- Status-specific schemas for `working`, `input-required`, and `submitted` statuses

**Deleted:**

- Removed redundant `-async-response-completed.json` and `-async-response-failed.json` files (6 total)
- For `completed`/`failed`, we now use the existing task response schemas directly

**Before:** The webhook spec tried to be universal, which created confusion about how A2A's native push notifications fit in.

**After:**

- MCP uses `mcp-webhook-payload.json` as its envelope, with AdCP data in `result`
- A2A uses its native `Task`/`TaskStatusUpdateEvent` messages, with AdCP data in `status.message.parts[].data`
- Both use the **exact same data schemas** - only the envelope differs

This makes it clear that AdCP only specifies the data layer, while each protocol handles delivery in its own way.

**Schemas:**

- `static/schemas/source/core/mcp-webhook-payload.json` (renamed + simplified)
- `static/schemas/source/core/async-response-data.json` (new)
- `static/schemas/source/media-buy/*-async-response-*.json` (6 deleted, 9 remain)

- Clarified that both MCP and A2A use HTTP webhooks (A2A's is native to the spec, MCP's is AdCP-provided)
- Fixed webhook trigger rules: webhooks fire for **all status changes** if `pushNotificationConfig` is provided and the task runs async
- Added proper A2A webhook payload examples (`Task` vs `TaskStatusUpdateEvent`)
- **Task Management** added to sidebar, it was missing

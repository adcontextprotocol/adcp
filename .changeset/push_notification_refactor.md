---
"adcontextprotocol": major
---

---

## "adcontextprotocol": major

Migrate webhook payload structure to fully adopt A2A Protocol's push notification payload format (A2A Specification Section 4.3.3). This is a breaking change that requires updating all webhook handlers.

**Breaking Changes:**

- **Webhook payload structure completely changed** - Now uses A2A StreamResponse format instead of custom ADCP format
- **Field paths changed**:
  - `task_id` → `task.id`
  - `status` → `task.status.state`
  - `result` → `task.status.message.parts[].data` (nested in parts array)
- **Top-level fields removed** - All task data now nested under `task` object
- **Schema structure changed** - Uses `oneOf` with A2A schemas (`task`, `message`, `statusUpdate`, `artifactUpdate`)

**What Changed:**

- Created 8 new A2A-compatible schemas matching A2A Protocol 1:1:
  - `a2a-task.json` (Section 4.1.1)
  - `a2a-message.json` (Section 4.1.4)
  - `a2a-task-status-update-event.json` (Section 4.2.1)
  - `a2a-task-artifact-update-event.json` (Section 4.2.2)
  - `a2a-task-status.json` (Section 4.1.2)
  - `a2a-part.json` (Section 4.1.6)
  - `a2a-artifact.json` (Section 4.1.9)
  - `a2a-role.json` (Section 4.1.5)
- Updated `webhook-payload.json` to reference A2A schemas
- Added version tracking metadata to all A2A schemas (`a2a_spec_version`, `a2a_spec_section`, `a2a_spec_url`, `adcp_synced_date`)
- Updated all webhook documentation to reflect A2A StreamResponse structure
- Added A2A schema validation test suite

**Migration Required:**

All webhook handlers must be updated to extract data from the new A2A structure:

**Before:**
const taskId = payload.task_id;
const status = payload.status;
const data = payload.result;**After:**ascript
const taskId = payload.task.id;
const status = payload.task.status.state;
const dataPart = payload.task.status.message.parts.find(p => p.data);
const data = dataPart?.data;**Benefits:**

- Full A2A Protocol compliance for webhook payloads
- Standardized structure across all A2A-compatible agents
- Better interoperability with A2A ecosystem
- Version tracking enables easier future A2A spec updates

**Reference:**

- A2A Protocol Specification: https://a2a-protocol.org/latest/specification/

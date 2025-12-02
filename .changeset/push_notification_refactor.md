---
"adcontextprotocol": major
---

---

## "adcontextprotocol": major

Migrate webhook payload structure to fully adopt A2A Protocol's push notification payload format (A2A Specification Section 4.3.3). This is a breaking change that requires updating all webhook handlers.

**Breaking Changes:**

- **Webhook payload structure completely changed** - Now uses A2A StreamResponse format instead of custom ADCP format
- **Payload is a StreamResponse object** containing exactly one of: `statusUpdate` (TaskStatusUpdateEvent), `task` (Task object), `message` (Message object), or `artifactUpdate` (TaskArtifactUpdateEvent)
- **Field paths depend on StreamResponse variant**:
  - For `statusUpdate`: `statusUpdate.taskId`, `statusUpdate.status.state`, `statusUpdate.status.message.parts[].data`
  - For `task`: `task.id`, `task.status.state`, `task.status.message.parts[].data`
  - For `artifactUpdate`: `artifactUpdate.taskId`, `artifactUpdate.artifact.parts[].data`
- **Status change events use `statusUpdate`** (most common for webhooks)
- **Final completion may use `task`** (for full task state)
- **Top-level fields removed** - All task data now nested within StreamResponse variants
- **Schema structure changed** - Uses `oneOf` with A2A schemas

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

All webhook handlers must be updated to handle the new A2A StreamResponse structure. The payload format depends on the event type:

- **Status changes** (`input-required`, `failed`, `working`) → Use `statusUpdate` variant
- **Final completion** → May use `task` variant for full state
- **Artifact updates** → Use `artifactUpdate` variant

Webhook handlers must check which StreamResponse variant is present and extract data accordingly. See updated documentation for complete extraction examples.

**Benefits:**

- Full A2A Protocol compliance for webhook payloads
- Standardized structure across all A2A-compatible agents
- Better interoperability with A2A ecosystem
- Version tracking enables easier future A2A spec updates
- Semantically correct event types (`statusUpdate` for status changes vs `task` for full state)

**Reference:**

- A2A Protocol Specification: https://a2a-protocol.org/latest/specification/

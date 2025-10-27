---
"adcontextprotocol": patch
---

Clarify webhook payload structure with explicit required fields documentation.

**Changes:**
- Added new `webhook-payload.json` schema documenting the complete structure of webhook POST payloads
- Added new `task-type.json` enum schema with all valid AdCP task types
- Refactored task schemas to use `$ref` to task-type enum (eliminates duplication across 4 schemas)
- Updated task management documentation to explicitly list required webhook fields: `task_id`, `task_type`, `domain`, `status`, `created_at`, `updated_at`
- Enhanced webhook examples to show all required protocol-level fields
- Added schema reference link for webhook payload structure

**Context:**
This clarifies an ambiguity in the spec that was causing confusion in implementations. The `task_type` field is required in webhook payloads (along with other protocol-level task metadata) but this wasn't explicitly documented before. Webhooks receive the complete task response object which includes both protocol-level fields AND domain-specific response data merged at the top level.

**Impact:**
- Documentation-only change, no breaking changes to existing implementations
- Helps implementers understand the exact structure of webhook POST payloads
- Resolves confusion about whether `task_type` is required (it is)

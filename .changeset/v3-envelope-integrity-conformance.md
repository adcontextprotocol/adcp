---
"adcontextprotocol": patch
---

feat(compliance): v3 envelope integrity universal storyboard

Adds `static/compliance/source/universal/v3-envelope-integrity.yaml` — a universal storyboard (applies to all agent interaction models) that asserts the v3 `status` field is present on the response envelope and that the legacy v2 `task_status` / `response_status` field names are absent.

Schema-level enforcement of the prohibition is provided separately by `envelope-forbid-legacy-status-fields.md` (top-level `not: { anyOf: [{ required: [task_status] }, { required: [response_status] }] }` on `protocol-envelope.json`). This changeset is the runtime/storyboard counterpart.

The explicit envelope-root field-absence assertions are wired as TODO `field_absent` checks pending runner support in `@adcp/client`; the immediate enforcement path remains the schema-level constraint, which any schema-aware validator detects without runner-specific primitives. Closes #3041 at the storyboard layer.

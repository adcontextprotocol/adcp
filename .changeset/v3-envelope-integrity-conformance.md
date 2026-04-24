---
"adcontextprotocol": minor
---

feat(compliance): add v3 envelope integrity storyboard and schema enforcement for legacy status field prohibition

Formalises the normative MUST NOT on `task_status` and `response_status` envelope fields (established in #2987 / #3021) as machine-checkable constraints:

1. `static/schemas/source/core/protocol-envelope.json` — adds `"task_status": { "not": {} }` and `"response_status": { "not": {} }` to the properties block. These v2 legacy field names are already prohibited by prose; the schema now encodes that prohibition so any JSON Schema validator can detect violations without reading the migration guide.

2. `static/compliance/source/universal/v3-envelope-integrity.yaml` — new universal storyboard (applies to all agent interaction models) that asserts `status` is present and `task_status` / `response_status` are absent at the envelope top-level. Scope is intentionally limited to the envelope root; nested `payload` domain data may legitimately carry a field named `task_status`.

Note: the `field_absent` check type used in the storyboard validation steps requires runner support in `@adcp/client`. The `response_schema` check against `protocol-envelope.json` is immediately effective for schema-aware validators. Closes #3041.

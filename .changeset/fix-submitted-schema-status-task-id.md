---
"adcontextprotocol": patch
---

fix(schema): add required status + task_id to all async submitted sub-schemas, close #4077

All six async-response-submitted sub-schemas (create-media-buy, update-media-buy, build-creative, sync-catalogs, sync-creatives, get-products) were missing `status: const "submitted"` and `task_id` from their `properties` and `required` arrays. The parent task-response schemas already required both fields in their submitted branches; the sub-schemas were simply inconsistent with the parent contract.

When `task_id` is omitted from a submitted envelope, jsonschema's deepest-schema-path heuristic picks the wrong union branch and reports a misleading status-enum error (`'submitted' is not one of ['pending_creatives', ...]`) instead of the actionable `required: task_id` violation. This sends implementors hunting through the wrong schemas. Empirically verified (adcp-client-python#570).

Each sub-schema now mirrors its parent's submitted branch: `status: const "submitted"`, `task_id` (x-entity: task), optional `message`, and optional advisory `errors`. `additionalProperties: true` retained to match all parent schemas. Descriptions updated from "usually empty or just context" to accurately describe the async-task polling contract.

Non-breaking: any conformant 3.0.0 implementation already emits both fields (the parent union's oneOf already enforces them at the wire level). The IETF errata test is satisfied — no previously-conformant implementation needs to change code.

Cherry-pick to 3.0.x after merge.

---
"adcontextprotocol": patch
---

Every task response schema and async status payload now composes `core/protocol-envelope.json` through its root `allOf`, as the envelope's notes already require. On MCP and REST the envelope fields (`status`, `task_id`, `context_id`, `context`, `message`, `timestamp`, `replayed`, `adcp_error`, `push_notification_config`, `governance_context`) are siblings of the body fields at the response root, but 47 of the 124 tool response and async status schemas did not compose the envelope, and 18 closed roots and `oneOf`/`anyOf` branches rejected envelope fields outright, because draft-07 `additionalProperties` does not see properties declared through `allOf`. Generated SDK types therefore could not represent a conforming response.

- `core/protocol-envelope.json` composes `core/version-envelope.json`, so `adcp_version` and `adcp_major_version` are envelope fields on every response, stamped by the server framework rather than carried as task data. Request schemas keep composing the version envelope directly; response schemas no longer do.
- The schema build declares every envelope property on each closed response root and closed branch as a `$ref` to its envelope declaration, driven by the envelope's own property list. A local declaration that narrows an envelope field, such as a compact branch's `status` const or a bounded `task_id` or `message`, is kept. Source schemas no longer copy `replayed` or `adcp_version` by hand.
- Async status payloads and the governance responses now require `status`, which the envelope already made required on every task response. Webhook `result` examples carry the task's `status`.

No body field is added, renamed or removed.

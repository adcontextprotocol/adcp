---
"adcontextprotocol": patch
---

Every task response schema and async status payload now composes `core/protocol-envelope.json` through its root `allOf`, as the envelope's notes already require. On MCP and REST the envelope fields (`status`, `task_id`, `context_id`, `context`, `message`, `timestamp`, `replayed`, `adcp_error`, `push_notification_config`, `governance_context`) are siblings of the body fields at the response root, but 43 of the 118 tool response and async status schemas did not compose the envelope. The two closed failure branches of the experimental `get_reporting_status` rejected `task_id`, `push_notification_config` and `governance_context`, because draft-07 `additionalProperties` does not see properties declared through `allOf`.

- `core/protocol-envelope.json` composes `core/version-envelope.json`, so `adcp_version` and `adcp_major_version` are envelope fields on every response, stamped by the server framework rather than carried as task data. Request schemas keep composing the version envelope directly; response schemas no longer do. The `request_proposals` and `refine_proposals` responses no longer copy `adcp_version` by hand.
- The two `get_reporting_status` failure branches are open, as response roots and status branches are (DR-0019), so every envelope field reaches them through the composition. No response root or status branch is closed. The rejection that closure provided is stated by name: a failed lookup forbids each body field of the success view, such as `account_id`, `ledger_snapshot_id` and `revisions`, so it still reveals no resource data.
- The `decline_proposals` completed branch accepts `status: "completed"`, as the `request_proposals` and `refine_proposals` completed branches do, instead of forbidding `status`.
- Async status payloads, the governance responses, and the `list_products`, `request_proposals`, `refine_proposals` and `decline_proposals` completed responses now require `status`, which the envelope already made required on every task response. Webhook `result` examples carry the task's `status`.

No body field is added, renamed or removed.

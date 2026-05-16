---
---

Closes #3721. Every refusal path in `send_invoice`, `confirm_send_invoice`, and `create_payment_link` now emits a `tool_error` person event with `{ tool, reason, lookup_key, org_id?, error? }` so admins can audit silent failures from the timeline. Resolves person_id from MemberContext (workos_user → slack_user fallback) at the tool boundary; recording is best-effort and never blocks the user-facing refusal. Adds `tool_error` to the `PersonEventType` union and 5 unit tests covering the new behavior.

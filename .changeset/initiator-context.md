---
"adcontextprotocol": minor
---

Application-Level Context in Task Payloads

- Task request schemas now accept an optional `context` object provided by the initiator
- Task response payloads (and webhook `result` payloads) echo the same `context`

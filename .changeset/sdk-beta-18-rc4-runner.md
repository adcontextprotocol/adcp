---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` to `8.1.0-beta.18` so local and CI storyboard runs enforce
`field_pattern` / `envelope_field_pattern` validations and include required
task webhook `operation_id` payloads, then teach the training agent to accept
the current `3.1-rc.4` wire release pin emitted by that runner.

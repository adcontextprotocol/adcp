---
"adcontextprotocol": minor
---

Report response properties the served release does not define (#8014). `versioning.mdx` §Extensibility adds a SHOULD: senders don't emit properties outside the served release's schema, except under `ext.{namespace}` or inside `x-adcp-open-payload` fields, because a misnamed field is silently ignored, and on `get_adcp_capabilities` it falls back to its default meaning. The runner output contract adds an authored `undefined_properties` check, always advisory and never failing a step. Its findings carry a JSON Pointer path, an optional suggested same-level field, and an optional `defined_in` for properties defined in a later release. The capability-discovery storyboard runs it on `get_adcp_capabilities`.

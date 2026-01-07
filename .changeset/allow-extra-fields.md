---
"adcontextprotocol": patch
---

Allow additional properties in all JSON schemas for forward compatibility

Changes all schemas from `"additionalProperties": false` to `"additionalProperties": true`. This enables clients running older schema versions to accept responses from servers with newer schemas without breaking validation - a standard practice for protocol evolution in distributed systems.

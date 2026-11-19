---
"adcontextprotocol": patch
---

Write every schema `examples` entry as an instance of its schema. 81 schemas wrapped their examples in a `{description, data}` object, which is not an instance, so 75 of them failed validation against their own schema. The wrappers are removed and the payloads are unchanged. The schema validation suite now validates every `examples` value as written, at the root and at nested positions, and rejects the wrapper.

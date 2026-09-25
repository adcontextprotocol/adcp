---
"adcontextprotocol": patch
---

Define the duration unit vocabulary once in `enums/duration-unit.json`. Duration values, frequency-cap requirements and interval constraints, and the `get_adcp_capabilities` frequency-capping declaration now reference the same enum instead of carrying duplicate or untyped definitions. The accepted values are unchanged; `supported_window_units` now rejects strings outside the vocabulary its description already mandated.

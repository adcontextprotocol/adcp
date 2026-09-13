---
"adcontextprotocol": patch
---

Define the duration unit vocabulary once in `enums/duration-unit.json`. `core/duration.json#/properties/unit` and `get_adcp_capabilities` `media_buy.frequency_capping.supported_window_units` items now reference the shared enum instead of carrying an inline copy (or an untyped string), so the value type and the capability that advertises it cannot drift. The accepted values are unchanged; `supported_window_units` now rejects strings outside the vocabulary its description already mandated.

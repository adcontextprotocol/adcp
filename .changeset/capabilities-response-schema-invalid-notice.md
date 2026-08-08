---
"adcontextprotocol": patch
---

Add the `capabilities_response_schema_invalid` canonical notice code and a `capability_pointer` (RFC 6901) optional notice field to the runner output contract, so a schema-invalid `get_adcp_capabilities` response is reported once as a root cause ahead of the track results instead of fanning out into unrelated-looking track failures.

---
"adcontextprotocol": patch
---

Clarify that the 64 KiB `MAX_CAPABILITIES_BYTES` budget on signing-key discovery (#8198) binds only the RFC 9421 profile's discovery path, which 3.3 deprecates and which gains no request field to narrow it. The Web Bot Auth key directory (DR-0023) makes no `get_adcp_capabilities` call and is unaffected. A creative agent with a large `creative.supported_formats` catalog adopts the Web Bot Auth profile or keeps its capabilities under the limit. Documentation only; no schema change.

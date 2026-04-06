---
"adcontextprotocol": minor
---

Add per-request version declaration and VERSION_UNSUPPORTED error code

**Version negotiation:**
- `adcp_major_version` field on `get_adcp_capabilities` request lets buyers declare which major version their payloads conform to
- Sellers validate against their `major_versions` and return `VERSION_UNSUPPORTED` if out of range
- When omitted, sellers assume their highest supported version

**Error codes:**
- `VERSION_UNSUPPORTED` — declared major version not supported by seller. Recovery: correctable.

**Documentation:**
- Version negotiation section in versioning reference
- Version negotiation flow and seller behavior in get_adcp_capabilities docs

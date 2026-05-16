---
---

docs(auth): forbid non-canonical bearer header aliases (`x-adcp-auth`)

Adds defensive prose to `docs/building/by-layer/L2/authentication.mdx` declaring `Authorization: Bearer` (RFC 6750 §2) the only header sellers may require or advertise for the bearer credential. Names `x-adcp-auth` explicitly as a legacy MCP-only alias that MUST NOT be required, MUST NOT be advertised as canonical in agent cards / capability responses / documentation, and MAY only be accepted as a transitional receive-side input alongside `Authorization: Bearer`. Closes the door SDK examples accidentally opened (see bokelley/salesagent#57 / #53).

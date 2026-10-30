---
"adcontextprotocol": patch
---

Docs: restate in the 3.3 release notes and the 3.2 → 3.3 migration guide that `adcp_major_version` and `adcp.major_versions`, deprecated since 3.1, are removed in 4.0 (DR-0035). Buyers send `adcp_version` on every request and keep the integer mirror through 3.x; in-house clients that send only the integer should switch now. Per DR-0034 (ratified), a request carrying only `adcp_major_version` is served the oldest supported release in that major; the versioning docs and the version-negotiation spec now say so.

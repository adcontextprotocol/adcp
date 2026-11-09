---
"adcontextprotocol": patch
---

Docs: DR-0036 records the decision of the 2026-11-09 working-group session. Schemas are open within a major. A schema is closed only for a structural reason: `oneOf` branch disjointness, a closed key set or vocabulary, or a signed or binding payload. Opening a 3.x schema that was closed without such a reason is a correction, so 3.3 opens those schemas and a 3.2.x patch does too. Once opened, a schema takes additions in later minors. The versioning page no longer says closed schemas stay closed until the next major. DR-0019 is superseded. DR-0032 and DR-0033, proposed in #8519 and never ratified, are recorded as withdrawn in favor of the versioning rules. No schema changes.

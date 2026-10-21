---
"adcontextprotocol": patch
---

schema: mark the 43 deprecated fields scheduled for removal in AdCP 4.0 with `"x-removed-in": "4.0.0"`, matching the 3 fields that already carried it (#8332).

The 4.0 compatibility registry (`universal/v4-compatibility.yaml`) now lists all 46 marked nodes once each: in a check's `schema_sites`, or in `schema_removals_not_checked` with the reason no check covers it yet. The registry lint fails the build when a marked node is unlisted or a listed site is not marked. A schema test requires the marker on every deprecated node whose description says it is removed in 4.0. Annotations only: no field, type, or requirement changes.

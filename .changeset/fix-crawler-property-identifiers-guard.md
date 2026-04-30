---
---

Fix crawler crash when an `adagents.json` property omits the `identifiers` array. `@adcp/client`'s `PropertyIndex.addProperty` iterates `property.identifiers` without guarding the field; we now monkey-patch the singleton at crawler startup to coerce a missing/non-array value to `[]`, so the property still lands in the agent index without crashing the whole crawl.

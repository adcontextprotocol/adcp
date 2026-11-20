---
"adcontextprotocol": minor
---

Audience size: add optional `unit` to `core/audience-size.json`, using the existing `enums/reach-unit.json` (`custom` excluded). Absent means `individuals`, so every shipped size keeps its meaning. CTV and streaming platforms that match lists to households or devices can now say so instead of reporting those counts as people, and buyers MUST NOT compare sizes whose units differ. The `reach-unit` enum already describes itself as the unit for audience size metrics, and `delivery-forecast` already declares `reach_unit` for its forecast audience sizes. `collection-distribution.followers` now sets `unit` to `accounts` instead of overriding the people wording in prose. Docs: the `sync_audiences` audience size section gains the field and a same-unit rule.

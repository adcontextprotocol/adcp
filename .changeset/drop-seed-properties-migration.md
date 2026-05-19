---
"adcontextprotocol": patch
---

Retire the 8.7 MB Scope3 publisher seed in migration 206. The migration body becomes a no-op (`SELECT 1`) — the data was a one-shot 2026-02-12 Scope3 BigQuery export of 1,250 publishers / 53,422 properties / 62,440 identifiers that aged into a stale snapshot in every runtime image. Production environments retain the data (the migration already ran months ago; Postgres doesn't re-run applied versions). Fresh installs start with an empty `hosted_properties` table and populate via the normal user-claim and discovery-crawler paths. Drops ~9 MB from every shipped image. Closes #4778.

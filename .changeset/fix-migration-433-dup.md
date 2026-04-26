---
---

Renumbers `433_catalog_adagents_lookup_index.sql` to `434_*` to break the duplicate-migration-433 deadlock on main. PRs #3235 and #3244 both landed migration 433 simultaneously, blocking every open PR at the duplicate-check and migration-build CI gates. Both files are kept (no SQL change) — only the filename prefix is bumped on the second-landed file. Migrations apply cleanly in 432 → 433 → 434 order locally; no code references either filename so this is a pure file rename.

---
---

Renumber `433_auto_provision_verified_domain.sql` to `434_auto_provision_verified_domain.sql` to resolve a collision with `433_catalog_adagents_lookup_index.sql` that landed in the same window. The migration runner (`server/src/db/migrate.ts:76-84`) throws on duplicate version numbers at startup, so this collision blocks every deploy and every PR's "No duplicate migration numbers" check until resolved. Catalog landed first (PR #3244, commit 3496020) and may already be recorded in `schema_migrations` as version 433 in some envs — auto_provision is renumbered instead so envs that already applied catalog see no mismatch above the baseline.

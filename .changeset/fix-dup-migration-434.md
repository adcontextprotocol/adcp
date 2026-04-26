---
---

Restore `434_catalog_adagents_lookup_index.sql` back to `433_catalog_adagents_lookup_index.sql`. PRs #3256 and #3257 both fixed the original 433 collision in parallel from different conductor workspaces — #3257 (auto_provision → 434) merged first, then #3256 (catalog → 434) merged on a stale view and re-introduced a collision, this time at version 434. This restores catalog to its original 433 number, leaving auto_provision at 434, matching how envs that deployed between #3257 and #3256 would have recorded the migrations in `schema_migrations`.

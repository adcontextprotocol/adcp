---
---

fix(certification): renumber the S6 security migration 513 -> 514 to resolve a duplicate migration version on main (513_collection_catalog.sql from #5522 merged first and claimed 513). migrate.ts rejects duplicate versions, so this unblocks migrations on main. Pure file rename — no SQL change.

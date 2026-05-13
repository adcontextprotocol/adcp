---
---

Add `find-person-relationship-email-conflicts.ts` script to diagnose and merge duplicate `person_relationships` rows that collide on email. The script runs dry-run by default; `--apply` delegates to the existing `resolvePersonId` merge path, which re-parents `addie_threads` and `person_events` atomically before deleting the loser row. Closes #4488.

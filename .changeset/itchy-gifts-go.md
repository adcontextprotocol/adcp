---
---

Fix founding member badge not displaying for members who joined after initial migration ran.

The original migration 147 only set `is_founding_member = TRUE` for profiles that existed at migration time. Profiles created afterward were not automatically flagged, even though they joined before the April 2026 cutoff.

Changes:
- Update `createProfile` to set founding member status based on cutoff date
- Add migration 180 to backfill existing profiles that should have the flag

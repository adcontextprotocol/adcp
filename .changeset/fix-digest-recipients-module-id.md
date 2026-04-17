---
---

Fix crash in `getDigestEmailRecipients` — `certification_modules` has neither a `module_id` column nor an `is_active` column, so the previous subquery threw `column "module_id" does not exist`.

Also correct the semantics for the newsletter's "You're X modules in — Y to go for your certification" nudge: `cert_modules_completed` and `cert_total_modules` are now scoped to the user's most recently touched track (via `learner_progress` joined to `certification_modules`). Previously the completed count was pulled from `certification_attempts` (track-level capstones, not modules) and the total was across every track globally, which overstated "Y to go" for users pursuing a single track.

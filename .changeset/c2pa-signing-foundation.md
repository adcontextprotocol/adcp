---
---

Stage 1 of C2PA provenance signing (#2370): shared `signC2PA()` helper, AAO cert generation script, and schema columns for tracking signed rows. No callers wired up yet — signing is gated behind `C2PA_SIGNING_ENABLED` plus cert/key Fly secrets, all default off.

Follow-ups wire this into `generateIllustration()`, docs storyboard generation, and `generatePortrait()`, then backfill existing rows.

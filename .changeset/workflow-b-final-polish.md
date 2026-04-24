---
---

**Workflow B final polish + ops runbook**

Closes the remaining review-deferred polish on the announcement
backlog view and adds the incident-response runbook flagged during
the #3003 review.

**Backlog view (`/admin/announcements`):**

- **Signup-age column** — new "Signed up" column between Tier and
  Draft posted. Renders relative ("3d ago", "2mo ago", "1y ago") so
  editorial can tell "recent welcome" from "stale backfill" without a
  click-through. ISO date in the title attribute for precise reads.
  Backend exposes `org_created_at` from `organizations.created_at`;
  null-safe for orphan drafts where the org row was deleted.
- **Empty-state copy** — "Pending review" and "LinkedIn pending" now
  show actionable copy ("Nothing to review. New drafts are posted
  hourly by the trigger job." / "Nothing waiting on LinkedIn right
  now.") instead of the generic "No announcements in state X."
- **Arrow-key tab nav** — Left/Right cycle, Home/End jump. Pairs
  with the `aria-selected` toggling already in place so the filter
  tabs follow the WAI-ARIA tabs pattern.

**Ops runbook:**

- New `ops/channel-rotation.md` — quick reference for rotating a
  Slack channel wired into an admin setting (all seven — billing,
  escalation, admin, prospect, error, editorial, announcement).
  Covers happy path, write/send-time failure modes, incident scenario
  for archived review channel, and break-glass direct-SQL rotation
  with audit-table capture for when the admin UI is down. Referenced
  during the #3003 review.

**Tests:** 2 new backlog query tests (org_created_at happy + orphan),
2 new route tests (ISO serialization + null passthrough). Full
announcement suite 172/172 pass; server typecheck clean.

**Skipped from the final polish list** (not worth the bytes at
current scale):

- Sortable column headers — the stuck-first default sort already
  answers the question; at 30-50 rows, scanning is fine.
- Vitest pool isolation for `tests/announcement/**` — the
  `mockResolvedValue({rows: []})` default works as a band-aid.
- Slack deep-link helper in the admin cannot_verify error state —
  UX work outside this thread.

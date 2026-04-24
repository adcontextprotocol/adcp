---
---

**Admin `/admin/announcements` backlog page**

Single surface for the editorial team to see what's waiting. Filter tabs
for **Pending review**, **LinkedIn pending**, **Done**, **Skipped**, and
**All**, with count badges on each tab. Per-row link to the account
detail page (Mark posted to LinkedIn lives there). Drafts older than
7 days in a non-terminal state are visually flagged as "stuck".

**Why.** Now that backfill can land 10-15 retroactive drafts in one run
(PR #2990), editorial needs a dashboard view beyond scrolling the Slack
channel. Flagged as the top follow-up during Stage 2/3 expert review.

**New:**

- `GET /api/admin/announcements` — returns per-org backlog rows with
  derived `state` bucket + per-state counts.
- `loadAnnouncementBacklog()` in `announcement-handlers.ts` — one-query
  join with `DISTINCT ON (organization_id)` for each state CTE so every
  org collapses to a single row regardless of duplicate activity
  history.
- `server/src/routes/admin/announcements.ts` — wires the page + API.
- `server/public/admin-announcements.html` — page with filter tabs,
  table view, BACKFILL badge on retroactive rows, stuck-days warning.
- Sidebar link in `admin-sidebar.js` under Community → Announcements.

**Not in this PR:** stale-LI alerting on the trigger job cadence is
the natural next step but hasn't shipped yet.

**Tests:** 4 query-shape tests in `announcement-backlog.test.ts` cover
row-mapping, legacy-row `is_backfill` coercion, SQL-uses-DISTINCT-ON,
and empty-result. 6 route tests in `announcement-backlog-route.test.ts`
cover state-bucket derivation (all four buckets), skipped-precedence
invariant, ISO date strings, backend-error 500, empty happy path. Full
announcement suite 154/154 pass.

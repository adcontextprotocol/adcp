---
---

Surface Gemini illustration-generation activity against the workspace
cap on the admin dashboard (closes #2796 ops metric requirement).

The workspace cap (50/day) and per-user co-author aggregation for
`generate_perspective_illustration` were already enforced in
`tool-rate-limiter.ts` (`WORKSPACE_CAPS`) and
`illustration-db.ts:countMonthlyGenerations`. What was missing from
#2796's acceptance criteria was ops visibility — a dashboard metric
for "illustration generations today" so operators can see cap status
without reading Gemini's billing console.

Changes:
- Exported `WORKSPACE_CAPS` from `tool-rate-limiter.ts` so the stats
  endpoint reads the configured cap value instead of hard-coding it.
- `/api/admin/stats` now includes `illustrations_generated_24h`,
  `illustrations_generated_7d`, `illustrations_cap_24h`, and
  `illustrations_cap_remaining` fields.
- Added a card to `admin.html`: "Gemini Illustrations (24h cost cap)"
  rendering generated / cap / remaining / 7d trend.

No new enforcement — this is pure visibility over the already-active
cap.

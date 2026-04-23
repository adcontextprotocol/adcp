---
---

Add the three-tier agent visibility selector (Private / Members only / Public) to each card on `/dashboard/agents`. The radios call `PATCH /api/me/member-profile/agents/:index/visibility`; the "Public" option is gated on Professional+ tier and a configured brand domain, with inline upsell/nudge messages when either is missing. Styling reuses the shared `.agent-card-visibility` / `.agent-visibility-option` classes from `member-card.js`.

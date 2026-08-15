---
"adcontextprotocol": minor
---

Add hard daily budget caps to the shared media-buy budget hierarchy (RFC #5983).

- Media-buy `daily_budget_cap` bounds aggregate daily spend without creating package allocations; optional package caps are subordinate ceilings, not reservations.
- One media-buy `budget_cap_timezone` defines the calendar-day boundary for every cap and defaults to the seller billing timezone.
- Legacy create/update and compact buy/control/accept lifecycle schemas expose the aggregate cap and timezone; package request/update/control and readback schemas expose only the subordinate cap.
- Numeric updates apply immediately with current-day spend counted; `null` removes a cap. Timezone changes begin at the next existing cap-day boundary.
- `media_buy.budget_capping` declares `supported_scopes`, `supported_periods`, `effective_timezone`, and optional buyer override support. A `daily_budget_cap` is always hard; sellers must reject unsupported scopes instead of silently dropping or softening them.

---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): period arithmetic and cutover edge cases found while building the canonical coverage vectors (#8616) are settled, and the vectors and reference model pin them.

- **Day start.** Under a local alignment, each local date's first instant is always a boundary: local midnight, or the first instant after a DST gap at midnight (Havana, Santiago, Cairo). Days therefore nest in every sub-daily schedule, and `PT24H` equals `P1D`; before, a nonexistent midnight left a 47-hour `PT24H` period, and `PT2H` didn't nest. New vectors: `havana-pt24h-equals-p1d-when-midnight-does-not-exist` and `havana-pt2h-nests-in-the-day`.
- **Lord Howe confirmed.** Literal wall-clock hours stand: a 30-minute DST change makes one hourly period 90 minutes long.
- **Two cutovers inside one period.** E is never earlier than the outgoing side's own start, so the incoming side carries that start forward, as both SDKs and the vectors already do.
- **Reactivation after a change made while inactive** resumes at the first boundary at or after the later of the reactivation instant and the end of the last period owed before deactivation, so nothing is owed twice. New vector: `reactivation-after-a-schedule-change-never-owes-twice`.
- **UTC aliases** are exactly `UTC` and `Etc/UTC`.
- **`billing_cycle` needs a date component.** A sub-daily `billing_cycle` would ignore its anchor, so it is now invalid (schema-enforced). New vector: `sub-daily-billing-cycle-is-refused`.
- **Weeks** (`P7D`) under `utc`, `account_timezone`, and `source_timezone` start on Thursday (1970-01-01); `billing_cycle` with an anchor sets another week start.
- **`status_retention_days`** counts exact 24-hour days.

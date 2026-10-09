---
"adcontextprotocol": minor
---

Add optional `change_cutoff` (`date-time`) to `installment-deadlines.json`: the last date/time at which a change to or stop of an installment (creative swap, pause, cancellation instruction) still takes operational effect, such as broadcast traffic/log close, OOH posting-cycle lock, print issue close, or cinema reel lock. Distinct from `cancellation_deadline` and `booking_deadline`; when both are present, `change_cutoff` SHOULD NOT precede `booking_deadline`. Documented in the installment deadlines section and the print channel guide. Refs #7777 (gap 1 only).

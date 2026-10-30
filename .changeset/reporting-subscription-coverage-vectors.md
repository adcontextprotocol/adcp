---
"adcontextprotocol": patch
---

Add canonical reporting-subscription coverage vectors (experimental `media_buy.reporting_subscriptions`) under `static/compliance/source/test-vectors/reporting-subscriptions/`, with a case schema and a pinned IANA tzdata release (2026f). There are 113 cases. 81 are ported from the TypeScript SDK's parity table and re-derived from the spec text. The new cases cover:

- DST gaps and folds at midnight in Santiago, Havana, and Cairo.
- Lord Howe's 30-minute DST.
- Sub-daily local periods at +05:45.
- Month-end clamps.
- Weeks (P7D) and years.
- Compound changes at one instant.
- Grant chains of four.
- `max_accounts` capacity per offering.
- Fractional seconds and offsets.
- Empty flights.
- The confirmation period.

The set also freezes two vocabularies both SDKs use verbatim:

- `error-codes.json`: the subscription and coverage error codes, each with its recovery class, whether the task was dispatched, and its fix.
- `reason-codes.json`: the coverage reason codes, which say why a period is or isn't owed, with the fixed rule order.

A brute-force reference model in `scripts/reference/reporting-coverage/` reproduces every case. It evaluates the zic source itself and shares no time zone code with either SDK. Property tests also check the model: exceptions only remove periods, nothing is owed twice, prefix stability, no retroactive extension, and calendar invariants.

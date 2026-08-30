---
"adcontextprotocol": minor
---

Add the static OOH channel contract (experimental in 3.2): an `ooh_metrics` delivery block — panels with multi-scheme identifiers, posting periods, share of voice, illuminated hours, modeled `estimated_impressions` with a declared methodology tier (`estimation_basis`), and posting records whose evidence artifacts use the new channel-neutral `placement-evidence` core schema (shared with print tearsheets) — plus an out-of-home channel guide. Also mirrors `measurement_source` from delivery-forecast into delivery-metrics (WG-ratified) so measured-channel rows are self-describing about whose data produced them. Static units have no play events; delivery is a period-level modeled audience estimate and settlement rests on proof-of-posting, per OAAA conventions.

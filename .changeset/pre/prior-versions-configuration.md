---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): each `prior_versions` entry on the subscription readback now carries the `configuration` that version had (scope, selector, destination, `reconciliation_mode`), and sellers MUST include it. A buyer that lost local state can then recompute a prior version's owed periods; before, the readback said when a version was accepted and superseded but not what it covered.

Reporting schedules (experimental): fix sub-daily periods under a local alignment (`account_timezone`, `source_timezone`, `billing_cycle`). They were anchored to local midnight on 1970-01-01 plus elapsed hours, so hourly periods in Asia/Singapore ran 07:30–08:30 local (its 1970 offset was +07:30), Asia/Kathmandu hours started at :15, and America/New_York PT6H boundaries drifted an hour with DST. A sub-daily duration under a local alignment now MUST divide 24 hours, and its boundaries are local wall-clock multiples counted afresh from each local midnight. A 23-hour DST day has 23 hourly periods and a 25-hour day 25; a nonexistent wall time yields no boundary, and a repeated one yields one per offset. Durations under a local alignment cannot mix date and time components. `utc` alignment is unchanged.

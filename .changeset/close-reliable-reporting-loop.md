---
"adcontextprotocol": patch
---

Add the opt-in experimental Reliable Reporting `sync_reporting_status` loop: buyers report whether each expected period was received, omitted from the seller ledger, missing its revision, or unreadable. Preserve immutable buyer-attributed status history beside seller obligations in `get_reporting_status`, detect when a previously received revision becomes stale after a seller restatement, surface caller-scoped mismatches as typed issues, and publish notice that the task becomes required Core only in the next eligible minor after October 24, 2026.

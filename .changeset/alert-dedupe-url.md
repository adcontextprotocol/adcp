---
"adcontextprotocol": patch
---

Fix alert deduplication to check external_url across all perspectives

The previous fix prevented new duplicate perspectives from being created,
but the alert query still matched existing duplicates and posted the same
article multiple times (once per perspective).

Now the alert query checks if ANY perspective with the same external_url
has been alerted to a channel, preventing spam from pre-existing duplicates.

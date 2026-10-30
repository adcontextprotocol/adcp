---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): a deactivated subscription no longer reads as active in `get_reporting_status`. `subscription_coverage[].status` gains `inactive`, with a required `deactivated_at`. Periods that started before deactivation stay owed, and no later ones are. An inactive subscription is listed only while it still has retained obligations for the account; after that its entry is omitted. Before, the status enum had no inactive value, so a deactivated subscription still in scope could only read as `active`.

---
"adcontextprotocol": minor
---

Harden every `report_plan_outcome` budget input. The source schema now requires
`delivery.spend` to be non-negative, and the reference governance handler
rejects negative, non-finite, or cumulatively overflowing delivery and seller
budgets before they can mutate the committed-budget ledger or audit log.

---
"adcontextprotocol": patch
---

Name the `invoice` resource type on the experimental `account.change_feed`: invoice changes use `resource.type: "invoice"` with `repair.task: "get_account_financials"` (`created`, `status_changed` with `reason` set to the new status, `updated`). A seller listing `invoice` in `resource_types` MUST return every invoice with a retained change record in `get_account_financials.invoices[]` when the request period overlaps the invoice period. Intermediaries record invoices they issue on their own feed and do not relay upstream records. No schema shape change; `account_financials` keeps spend, credit and payment-status changes.

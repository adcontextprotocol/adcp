---
"adcontextprotocol": minor
---

Add contingent revenue-share pricing for affiliate and other outcome-priced media.

The new `revenue_share` pricing option applies a decimal `commission_rate` to settled `commissionable_value`. Product discovery can filter fixed, auction, and contingent pricing independently; delivery and `report_usage` expose the commission basis for formula-checked reconciliation.

Revenue-share packages bind billing to an event source and measurement window, do not use `bid_price`, and treat package budget as the maximum payable commission.

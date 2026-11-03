---
"adcontextprotocol": minor
---

Add optional budget period, constrained-budget locator, constraint cause, and
contributing field details to BUDGET_TOO_LOW errors so buyers can distinguish daily and lifetime minimums
and identify bid-dependent floors without confusing a budget minimum with a
rejected bid. Existing budget error details remain valid;
daily_budget_cap remains a hard ceiling. This implements the error-recovery
portion of #8685; daily minimum discovery and averaged-budget execution remain
proposed for 4.0.

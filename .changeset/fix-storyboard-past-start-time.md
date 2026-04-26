---
---

Advance hardcoded 2026-04-01 / 2026-04-07 dates in compliance storyboards to 2027-06-01.

The original dates are now in the past. Conformant seller agents that enforce INVALID_REQUEST
for past start_time correctly rejected storyboard requests before reaching the intended behavior
(e.g. GOVERNANCE_DENIED), causing false failures. No DSL dynamic-date mechanism exists yet;
bumping to a far-future date restores correctness until a $generate:future_date expression type
can be introduced. Test-vector JCS hashes and sales-social event_time (historical event data) left unchanged.

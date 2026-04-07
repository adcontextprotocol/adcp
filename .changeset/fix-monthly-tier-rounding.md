---
---

fix: membership tier inference for monthly billing rounding

Lower tier-inference thresholds by ~4% to account for integer-cent rounding
when monthly subscription amounts are annualized. $250/yr billed monthly
(2083 cents/mo) annualizes to 24 996 cents, which fell below the exact
25 000 threshold and caused Professional members to appear as Explorer.

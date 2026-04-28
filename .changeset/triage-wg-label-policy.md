---
---

Triage workflow now sends a LABEL POLICY directive to the routine for `ready-for-human` issues: apply `needs-wg-review` plus a domain label (`media-buy`, `signals`, `creative`, `brand`, `governance`, `sponsored-intelligence`, `schema`, `compliance-suite`, `addie`, `rfc`, etc.) so the working group can route from a single label query. PR-comment runs unchanged. Pure engineering issues (CI, deps, tooling) skip the WG labels.

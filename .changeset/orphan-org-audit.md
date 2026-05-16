---
---

Daily orphan-org audit job. Surfaces non-personal orgs missing `email_domain` (and therefore unable to auto-link future @domain signups via `findPayingOrgForDomain`) but with evidence of a sales/discovery touch (Stripe customer, prospect_source, etc.). Posts a structured log + Slack summary to the prospect channel; flags regressions when fresh orphans appear in the last 24h. Catches future leaks in the at-INSERT hardening within a day instead of months.

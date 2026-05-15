---
"adcontextprotocol": patch
---

`sync-email-domain-from-is-primary.ts` now classifies drift into three buckets (`null`, `www_drift`, `mismatched`) and only applies the `null` class by default. `www_drift` (the Scope3 class) is opt-in via `--include-www-drift`. `mismatched` is the subsidiary/M&A class (e.g. `linkedin.com` vs `microsoft.com`) and is never auto-fixed — those cases are surfaced for human review and are better modeled via `brands.house_domain` + `brand_domain_aliases` than by overwriting `email_domain`. Applied to prod 2026-05-12: 7 null cases backfilled.

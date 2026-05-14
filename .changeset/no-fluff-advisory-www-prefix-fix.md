---
---

Update the No Fluff Advisory per-case-fix in `stage0-domain-cleanup` to expect `www.linkedin.com` (their actual stored value) instead of bare `linkedin.com`. The earlier expectation aborted on dry-run because the value was www-prefixed.

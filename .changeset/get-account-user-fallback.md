---
---

`get_account` now falls back to the `users` table when no organization matches the query. Inbound website signups don't create an org row (the user self-serves during onboarding), so previously asking Addie "who signed up from <company>?" would return "no record" even when the person was already in `users`. The fallback surfaces those signups, separates orphan signups (no org yet) from users already in another org, and points at `add_prospect` as the next step.

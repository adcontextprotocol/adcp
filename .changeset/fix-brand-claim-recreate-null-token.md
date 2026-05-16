---
---

Fix `request_brand_domain_challenge` returning silent `workos_error` when the WorkOS org already had a non-verified domain entry with null `verificationToken`/`verificationPrefix`. The pre-check now deletes the broken entry and falls through to a fresh create, so the user receives a usable DNS TXT record instead of looping on the same error. Closes #3953.

---
---

Fix brand-claim silent failure when existing WorkOS domain entry has null verificationToken or verificationPrefix. The idempotent pre-check now deletes the stale row and falls through to a fresh create rather than returning the unusable row as ok:true.

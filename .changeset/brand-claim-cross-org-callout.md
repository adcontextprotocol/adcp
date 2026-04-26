---
---

Surface the WorkOS DNS challenge inline when a member tries to save a brand identity for a domain that's already owned by another org (409 cross_org_ownership). Admins can now self-service the claim from the member-profile page without leaving for the chat or waiting on the escalation queue. The /brand-identity 409 response now includes a `code: 'cross_org_ownership'` field so the UI can branch.

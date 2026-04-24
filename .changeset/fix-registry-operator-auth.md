---
---

Fix `GET /api/registry/operator` to honor caller auth. The endpoint now accepts a WorkOS Bearer API key (or session cookie) and tiers agent visibility accordingly: `public` always, `members_only` when the caller's org has API-access tier, and `private` when the caller's org owns the profile. Previously the route hardcoded `visibility === 'public'` and ignored the Authorization header, so members_only/private agents were never returned.

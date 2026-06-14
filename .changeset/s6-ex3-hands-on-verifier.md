---
---

feat(certification): make S6 exercise 3 (governance token verification) hands-on for the rejection cases, now that the `verify_governance_token` sandbox verifier ships (#5520). Adds the verifier sandbox action and a gated criterion to observe a valid token accepted and tampered / misaddressed / revoked tokens rejected, and reconciles docs/learning/specialist/security.mdx ex3 accordingly. Migration 515 (additive criterion) + doc; no SQL/schema change beyond the appended criterion.

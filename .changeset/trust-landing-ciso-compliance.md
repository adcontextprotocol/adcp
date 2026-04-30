---
---

docs(trust): add trust & security landing page for CISOs and compliance reviewers

Adds `docs/trust.mdx` — a landing page for CISOs, compliance reviewers, and procurement teams evaluating an AdCP deployment. Covers the six trust surfaces (governance, regulatory, privacy, security, provenance, disclosure) with accurate framing: each pillar describes what AdCP provides as a seam and what it explicitly does not enforce, linking to the canonical detail pages. Includes a "For compliance reviewers" quick-reference table of wire-level hooks.

Uses the defensible thesis from the issue brief: AdCP separates decisions so no single agent can act unilaterally, and makes every decision cryptographically re-verifiable — but it does not enforce policy; deployers do, through the seams the protocol provides. Specifically avoids the three overclaims that caused PR #2814 to be withdrawn: (1) no claim that webhooks are HMAC-signed — correctly states RFC 9421 as the baseline; (2) no claim that AdCP Verified provides formal attestation in 3.0 — correctly states self-attestation with the formal program launching in 3.1; (3) no claim that `check_governance` enforces policy — correctly describes it as a seam a deployer wires to their governance platform. Adds the key-transparency limitation (trust-on-first-use with continuity, not cryptographically closed) per `known-limitations.mdx` lines 43–44.

Adds `docs/trust` to the top-level nav in both the `3.0` (default) and `latest` versions of `docs.json`, alongside `docs/faq` and `docs/ai-disclosure`. No schema, server, or protocol changes.

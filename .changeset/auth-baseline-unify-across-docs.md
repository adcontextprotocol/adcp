---
---

docs(auth): unify 3.0 / 3.1+ auth baseline across three pages

The authenticated-operation matrix was stated inconsistently across
`docs/building/integration/authentication.mdx`,
`docs/building/understanding/security-model.mdx`, and
`docs/reference/known-limitations.mdx`. The integration page previously
said "AdCP uses Bearer token authentication" as if Bearer were the only
mechanism. The security-model layer-1 bullets enumerated three
mechanisms but only noted that RFC 9421 was "normative in 3.1" without
surfacing the 3.0 baseline or the Bearer-on-mutating sunset. The
limitations page had the most accurate statement but nothing linked to
it from the two pages a new integrator would actually start on.

Replaces the Bearer-only paragraph in `authentication.mdx` with a
three-mechanism matrix (RFC 9421 / mTLS / Bearer × 3.0 / 3.1+) plus a
Warning box stating that Bearer over TLS is the effective floor for
mutating operations in 3.0, and that operators committing spend SHOULD
ship RFC 9421 before 3.1 to avoid a forced cutover. Adds per-mechanism
subsections cross-linking to the request-signing profile and the
implementation security reference.

Updates the security-model Layer 1 bullets to name the same three
mechanisms with the same version gating, cross-links to the new
authentication matrix and to `known-limitations.md#authentication-and-identity`,
and updates the "what to verify before going live" checklist to flag
the Bearer-on-mutating sunset explicitly.

No normative change — the underlying rules already existed in
`docs/building/implementation/security.mdx` and the schema capabilities.
This is a docs-coherence fix so the three pages a new integrator reads
give the same answer.

---
---

docs(aao-verified): reconcile (Spec)/(Live) qualifier framing across spec docs

PR #2153 reframed `aao-verified.mdx` to the **(Spec)** / **(Live)** qualifier model — one brand mark with two composable axes — but the rename didn't propagate to all the docs that cross-reference the mark, and `conformance.mdx` ended up with two contradictory framings on the same page.

This changeset accompanies the doc reconciliation: `conformance.mdx` "Two marks" section replaced with a single qualifier-aware pointer; `build-an-agent.mdx` and `seller-integration.mdx` call-outs reframed; six (Live)-specific call-sites in `accounts/overview.mdx` plus two in `account-authorization.json` schema description qualified to **(Live)** where they bind to the `attestation_verifier` scope; three sections from #3001 (How to claim each qualifier, What AAO Verified is not, Relationship to supporting specs) added to `aao-verified.mdx`.

Doc-only and additive — no schema-shape or normative changes beyond clarifying which axis each call-site refers to. The wire contract for `attestation_verifier`, the `authorization` envelope, and the eight observability checks is unchanged.

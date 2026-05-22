---
---

fix(adagents): unify `publisher_domain` canonicalization across writer/validator/adagents-manager

Closes #4541. Code-reviewer-deep follow-up from PR #4538.

**The drift.** Three consumers compared `publisher_domain` strings against each other with different normalization rules:

- `server/src/db/publisher-db.ts` (catalog projection writer): plain `.toLowerCase()` on the source domain, selector matches, and `revoked_publisher_domains[]` entries.
- `server/src/adagents-manager.ts` (`hasExplicitPublisherScope`, the `managerdomain` fallback safety gate): plain `.toLowerCase()`.
- `server/src/validator.ts` (`selectorTargetsDomain`, `propertyMatchesDomain`, placement/collection filters): `normalizeDomain` which additionally stripped `http(s)://` scheme and trailing slashes.

A loose-typed manifest with `selector.publisher_domain: "https://cnn.com"` matched in the validator but failed cross-publisher refusal in the writer. Trailing-dot DNS-canonical forms (`"site.example."`) varied similarly. Catalog projection and live validation could disagree on whether two strings refer to the same publisher — the security boundary the writer enforces.

**The fix.** New `server/src/services/publisher-domain.ts` exports `canonicalizePublisherDomain(raw)` which:

- lowercases
- trims surrounding whitespace
- strips an `http(s)://` scheme prefix (defensive — schema pattern already rejects but writer/validator both accept loose-typed input)
- strips trailing slashes and trailing dots (DNS-canonical form)

Does NOT do SSRF rejection (that concern stays in the validator's `normalizeDomain` for URL-bearing input) or IDN/punycode conversion (schema pattern rejects non-ASCII today).

Applied at every `publisher_domain` comparison site in the three consumers. Validator's `normalizeDomain` keeps its SSRF guards for source-side input but gains trailing-dot stripping so it produces the same canonical form as the shared helper for clean inputs.

**Tests.**

- `server/tests/unit/publisher-domain.test.ts`: 8 unit tests covering lowercase / trim / trailing-dot / trailing-slash / scheme strip / canonical-form equivalence across representations.
- `server/tests/integration/registry-catalog-agent-auth-writer.test.ts`: two new integration tests locking trailing-dot and scheme-prefix selector forms as accepted by the writer (regression coverage for the drift the unification closes).
- Existing 95 adagents-manager unit tests still pass.

**Reference**: #4541 (issue), PR #4538 code-reviewer-deep should-fix #3 (origin).

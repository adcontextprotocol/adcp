---
"adcontextprotocol": patch
---

spec(governance): plan_hash polish bundle — additive items from #2480

Lands the zero-breaking items from the plan_hash polish bundle. Pre-GA additions to the "Plan binding and audit" section that reduce divergence risk among early implementers without changing any existing behavior:

**Spec polish (`docs/governance/campaign/specification.mdx` — Plan binding and audit):**

- **Fail-safe on unknown bookkeeping fields.** Appended to the closed-list paragraph: implementations that discover additional GA-internal fields on their persisted plan state MUST treat them as IN the preimage until the profile version bumps. Closes the "anything that looks like bookkeeping → strip" shortcut that silently diverges implementations.
- **Unicode homograph hardening.** Added to the caller-guidance bullets: `policy_ids` and `policy_categories` SHOULD be validated against a canonical allowlist server-side. JCS detects byte-level divergence correctly (visually-indistinguishable variants produce distinct hashes); this rule closes the plan-semantics gap where a homograph substitution authorizes a different enforcement outcome.
- **Constant-time comparison hint broadened.** The existing auditor-only hint was generalized to all three verifier types (governance-agent self-integrity, auditor, buyer-side compliance) as a new "Constant-time comparison" paragraph at the end of the verification recipes. Cites `crypto.timingSafeEqual`, `hmac.compare_digest`, `crypto/subtle.ConstantTimeCompare`.
- **Privacy considerations subsection.** New paragraph documenting the plan-mutation-cadence inference vector: parties retaining `governance_context` tokens can infer plan-mutation cadence from the sequence of distinct `plan_hash` values. Sensitive deployments should factor this into retention policy.

**Test vectors (`static/compliance/source/test-vectors/plan-hash/`):**

- **008-numeric-canonicalization.json** — new vector with fractional percentages (33.33, 33.334, 66.666) exercising RFC 8785 §3.2.2.3 number serialization. Pins library choice: hand-rolled `JSON.stringify + key sort` is likely to diverge on numeric edge cases that a JCS-compliant library handles correctly. All 11 vectors verified against `canonicalize@3.0.0`.
- Vector-count references updated from "ten" to "eleven" in the spec and in the `check_governance` / `sync_plans` task pages.

**Tooling:**

- **`canonicalize` pinned to exact version** (`3.0.0`, no caret) in `package.json`. Drift risk: a patch release that changes `-0` / `NaN` / `Object.create(null)` handling would silently invalidate every vector. Pin now so vector regeneration is reproducible and changes in library behavior surface as explicit dep-update PRs.
- **`.gitattributes`** added at repo root with `text eol=lf` for `static/compliance/source/test-vectors/plan-hash/**` and `static/test-vectors/**`. Prevents Windows CRLF conversion from silently changing bytes and invalidating the recorded SHA-256 digests (especially vector 007 with combining marks and Hebrew text).

**Deferred to 3.1 (not in this PR):**

- `revisionHistory` parenthetical rephrase (spec restructure, not a one-line polish).
- Cross-reference anchor verification (done opportunistically — `#signed-governance-context` and `#plan-binding-and-audit` both resolve today).

Vector generator note: no generator script exists yet under `.context/generate-plan-hash-vectors.mjs` as the original issue assumed. Vector 008 was computed inline using `canonicalize@3.0.0` + Node.js `crypto`. A generator can be factored out in a follow-up; the pinned dependency is the prerequisite regardless.

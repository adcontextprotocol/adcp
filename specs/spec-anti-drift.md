# AdCP RFC: Anti-drift architecture for normative guarantees

## Summary

The security audit of AdCP-as-a-protocol surfaced ~25 findings. Almost none were
crypto-design failures. The recurring shape was: **a guarantee stated in prose,
diluted at the layer that actually enforces it** — a `MUST` with no schema
backing, a reference snippet that was never executed, a fact hand-copied into
four documents that drifted apart.

This RFC proposes the systemic fix. The organizing principle is one sentence:

> Make the enforcement layer the source of truth, and generate or lint the prose
> *from* it. Push every check to the cheapest deterministic layer that can hold
> it, and reserve the governing agent for the judgment calls that genuinely
> require reading intent.

It adds two primitives that do not exist today — a **normative-statement
registry** and a **claims ledger** — turns the existing (but non-blocking)
snippet/coverage tooling into gates, and defines the security agent's role as a
*test-factory and red-teamer*, not a runtime gate.

## Motivation: why the audit findings slipped through

The repo already has substantial anti-drift tooling. The audit findings survived
because of specific, fixable gaps in how that tooling is wired — not because it
is absent.

| Audit finding | Why existing tooling missed it |
|---|---|
| Reference verifier tests `j.example_use` (a field that does not exist) instead of `j.adcp_use` — dead code that silently disables key-purpose separation (`L1/security.mdx:1684`) | `L1/security.mdx` is **not** marked `testable: true`, so its snippets are never extracted or executed. `check-testable-snippets.cjs` is **non-blocking** ("Always exit 0 — informational"), **diff-only** (changed files in a PR, never the whole corpus), and only checks whether a block is *marked* testable — it never verifies a marked block is correct. |
| `EXCLUDED_FROM_HASH` reference constant omits a member of its own normative closed list (`L1/security.mdx:498`) | Same page-not-testable gap. Also: the snippet test lane is **integration-gated** (needs a live agent + auth token) — the wrong tool for a pure-logic constant/verifier bug, which needs a deterministic unit-doctest. |
| Governance `phase` enum cannot express `intent`, yet the JWS profile treats `intent` as load-bearing (`enums/governance-phase.json` vs `L1/security.mdx:611`) | No linter asserts that every phase/claim value named in prose appears in its enum. Prose and schema are maintained by hand, independently. |
| "Three categories" (`known-limitations.mdx:49`, `trust.mdx:119`) vs **four** in `sync-plans-request.json` and `registry/policies/eu_ai_act_annex_iii.json` (adds `pharmaceutical_advertising`); prose also describes an `authority_level` field that no longer exists | The category list is authored by hand in 4+ places. No single source of truth; no lint that the doc tables match the schema/registry. |
| `signing_keys` pin is `MUST` in prose but optional in schema; `relationship`↔`delegation_type` equality is prose-only | No registry of normative statements tagged by enforcement layer, so "prose `MUST` with no schema/vector backing" is invisible and uncountable. |
| verify_brand_claim / rights_constraint / content-digest verifier bindings missing | Conformance vectors test that valid inputs pass; there is no requirement that every verification control ship a paired *negative* vector (`expected: reject`) for the forged input. |
| TMP "buyer cannot tie a user to a page" is falsified by the intended impression-pixel flow | No claims ledger requiring each "defends against X" claim to link a demonstration. Writing that demonstration is where the gap is found. |

The through-line: **truth lives in prose; enforcement lives elsewhere; nothing
keeps them in sync.**

## Architecture: cheapest deterministic layer holds each check

Every check wants the lowest, most deterministic layer that can hold it. The
governing agent is the *last* resort, not the first — a non-deterministic
reviewer is itself a drift source.

| Drift class | Enforcement layer | Owner |
|---|---|---|
| Prose ↔ reference-code | **Executable snippets** — extract & run every normative block in CI (unit-doctest lane for pure logic; integration lane for wire calls) | `check-testable-snippets` (made blocking + whole-corpus) |
| Prose ↔ schema | **Schema is source of truth** + linter that every prose `MUST` has a schema/enum backing | new `check-normative-coverage.cjs` |
| Cross-document fact drift | **Single source per fact; generate the doc tables** (or lint that they match) | schema/registry + remark generator |
| Missing verifier-side binding | **Negative/attack test vectors** — `expected: reject` on the forged input, paired with every verification control | conformance suite (storyboards + test-vectors) |
| Prose-`MUST` not conformance-tested | **Conformance suite run against SDKs + training agent** as fixtures | `training-agent-storyboards` extended to SDKs + negative vectors |
| Claim overstatement | **Claims ledger** + periodic adversarial pass (agent + human) | security agent + release red-team |

Only the last row genuinely needs judgment. Everything above it is mechanically
checkable and must never reach the agent's desk twice.

## New primitive 1: the normative-statement registry

Model: `scripts/check-registry-completeness.cjs`, whose own comment states the
pattern — *"Schema validation can't tell X from Y. CI is the enforcement point."*

Every `MUST` / `MUST NOT` / `SHOULD` in the security-relevant spec gets a stable
ID and an entry declaring **where it is enforced**. This makes the invisible
countable:

- *N* normative statements, *M* automatically enforced, *K* explicitly punted to
  operators, *P* that **claim enforcement but have no linked check.**

That last bucket is the drift surface. The `example_use`, phase-enum, and
`check_id` findings are each exactly one row in it.

Files (this RFC ships the seed):

- `static/registry/normative-statements/schema.json` — entry schema (draft-07,
  matching repo convention).
- `static/registry/normative-statements/index.json` — seeded with the audit
  findings as real entries, each tagged `status: gap` with a `finding_ref`.
- `scripts/check-normative-coverage.cjs` — validates entries, computes the
  coverage dashboard, and **fails CI** on any entry with `status: enforced` whose
  `enforced_by` link is empty or points at a nonexistent file. (A `gap` entry is
  allowed to have no enforcement — that is the honest starting state.)

Entry shape (see the schema for the full contract):

```json
{
  "id": "NS-SIG-001",
  "type": "normative-statement",
  "class": "signing",
  "level": "MUST",
  "statement": "A request-verifier MUST reject a JWK whose adcp_use is not 'request-signing'.",
  "source": "docs/building/by-layer/L1/security.mdx:1237",
  "enforcement_layer": "executable-snippet",
  "status": "gap",
  "enforced_by": [],
  "finding_ref": "audit-2026-07/T1-1",
  "notes": "Reference verifier at :1684 tests non-existent field 'example_use'."
}
```

The coverage number becomes the honest answer to *"how do we know we aren't
drifting?"* — you point at it, and the invariant is that it only moves up.

### Worked example: the doctest that would have caught `example_use`

The `example_use` bug (finding T1-1) survived because the reference verifier was
never executed. A `doctest`-marked block is self-contained and offline — the
doctest lane runs it on every scan and fails CI if it throws. This block asserts
the exact invariant the bug violated (key-purpose separation must test
`adcp_use`, not a field that does not exist):

```javascript doctest
// Regression guard for audit finding T1-1 (NS-SIG-001).
// A request verifier must accept a request-signing key and reject a key
// published for a different purpose. The bug tested `example_use` (undefined),
// so the good key failed and the check was quietly disabled.
function keyPurposeOk(jwk) {
  return jwk.use === 'sig'
    && Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify')
    && jwk.adcp_use === 'request-signing';   // NOT jwk.example_use
}
const requestKey    = { use: 'sig', key_ops: ['verify'], adcp_use: 'request-signing' };
const governanceKey = { use: 'sig', key_ops: ['verify'], adcp_use: 'governance-signing' };
if (!keyPurposeOk(requestKey))    throw new Error('valid request-signing key must pass');
if (keyPurposeOk(governanceKey))  throw new Error('governance key must NOT verify a request');
console.log('T1-1 guard ok');
```

Had the shipped reference used `example_use` here, `keyPurposeOk(requestKey)`
would return `false`, the first assertion would throw, and this block would fail
CI — turning a silently-disabled control into a red build.

## New primitive 2: the claims ledger

The hardest class (TMP structural-privacy overstatement) is about whether a prose
claim exceeds what the mechanism delivers — not mechanically checkable, but
*forceable at authoring time*.

Every security-facing claim — "defends against X", "prevents Y", "structurally
separate" — gets an ID and a **linked demonstration**: either a test vector that
exhibits the defense, or a threat-model entry that scopes it. A claim with no
linked artifact is a lint failure.

This is what would have caught the TMP finding: forcing the "buyer cannot tie a
user to a page" claim to point at a passing test means *writing* that test —
and the test fails on the impression-pixel re-correlation. The gap is found at
authoring time, not in an audit a year later.

Claims share the registry file (`type: "claim"`) with a `demonstrated_by` field
in place of `enforced_by`.

## The security agent's role: factory, not gate

The governing agent (Spec Guardian / security specialism) should **not** be the
enforcement for anything mechanically checkable — that is drift with extra steps,
because the agent is non-deterministic and would itself vary run to run. Its two
jobs:

1. **Red-team on a cadence** — run the adversarial passes that *find* new gaps
   (this audit, repeated per release and per new surface).
2. **Route every finding to the cheapest deterministic layer** — its output is
   mostly PRs that add schema constraints, lint rules, and test vectors, plus new
   registry rows. The standing invariant it holds about itself: *anything I find
   that is mechanically checkable, I encode as a check so I never find it again.*

This fits the class-based routing in the Spec Guardian secretariat proposal:
security becomes a routing class whose decision-records land as registry entries
and CI checks.

## Sequencing

Fix and enforcement ship together — never fix a finding without leaving behind
the check that would have caught it.

- **Phase 0 — instrument first.** Land the normative-statement registry (seeded),
  the coverage linter, and the unit-doctest lane. Mark `L1/security.mdx` and the
  other security-normative pages `testable: true`. This establishes an honest
  baseline coverage number *before* any fix, so every fix shows up as a gain.
- **Phase 1 — fix Tier 1 with enforcement attached.** e.g. fix `example_use` +
  the doctest that would have caught it; add `intent` to the enum + a lint that
  every JWS phase value appears in the enum; make `check_id` schema-required + a
  negative vector; add the verifier bindings + paired attack vectors. Each PR
  moves a registry row from `gap` to `enforced`.
- **Phase 2 — backfill Tier 2** by promoting prose `MUST`s into schema where
  possible and into conformance vectors where not, graded against SDKs + the
  training agent (already at 32/55 storyboards; extend to SDKs and negative
  vectors).
- **Phase 3 — claims ledger + standing adversarial pass** for the classes that
  stay judgment-bound.

## Changes to existing tooling

- `check-testable-snippets.cjs`: make blocking; add a whole-corpus mode
  (not diff-only) for security-normative pages; split into a **unit-doctest lane**
  (deterministic, no live agent — for verifier logic, canonicalization, constant
  lists) and the existing integration lane.
- `docs-example-coverage.cjs`: promote from "publish trends" to a **gate with a
  ratchet** on the security-normative page set (coverage may not decrease).
- Generate the regulated-category doc tables from the schema/`registry/policies`
  so "three vs four categories" cannot drift; delete prose references to removed
  fields (`authority_level`) as part of the same generator.

## Success metric

**The same finding must never appear in two consecutive audits.** If it does, the
fix went into prose again instead of into a layer. The registry coverage number
is the leading indicator; the repeat-finding count is the lagging one.

## References

- Security audit (2026-07): `specs/` companion / issue #3925 (Trust, Identity,
  and Governance master issue).
- `scripts/check-registry-completeness.cjs` — the registry-linter pattern this
  RFC generalizes.
- `scripts/check-testable-snippets.cjs`, `scripts/docs-example-coverage.cjs` —
  the snippet/coverage tooling this RFC makes gating.
- Related principle already in the codebase: conformance assertions must have a
  normative basis (assert a spec `MUST` or schema-required, never scenario prose).

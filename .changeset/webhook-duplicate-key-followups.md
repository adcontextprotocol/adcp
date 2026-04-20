---
---

Five follow-ups to PR #2522's duplicate-key MUST-reject tightening, plus three rounds of expert review on this PR itself, all landing together. Closes #2545, #2546, #2547, #2549, #2551.

## Admission-pressure — categories normative, numbers non-normative

`security.mdx` webhook replay dedup sizing section specifies only the four **categories** (short-window ratio, medium-window ratio, long-window ratio, proportional ceiling) and the requirements that thresholds be operator-configurable, that the alarm payload name the triggering clause (a/b/c/d), and that alarms route to incident response not automatic revocation (auto-revocation creates a DoS vector — any legitimate onboarding can trip the alarm). Concrete threshold numbers live in the non-normative [Webhook Verifier Tuning Guide](/docs/building/implementation/webhook-verifier-tuning) at `docs/building/implementation/webhook-verifier-tuning.mdx`.

**Tuning guide** contains:
- Starting-values table (3× / 2× / 1.5× / 20 / 10%) with explicit framing as starting points, not defaults.
- **First-30-days oracle warning** — operators MUST tune within 30 days; implementations SHOULD randomize starting thresholds by ±30% on first deployment so no two deployments ship identical defaults.
- Baselining methodology (30-day traffic survey, P50/P95/P99, onboarding-batch documentation).
- **Ten attack-scenario walkthroughs**: sudden mass-compromise, multi-week ramp, multi-quarter ramp, sparse-traffic burst, enterprise-scale ceiling, onboarding-burst false positive, **key-rotation storm** (legitimate fleet rekey after peer CA compromise), **thin-history window** (days 1–90 post-deployment, clause degradation), **intermittent low-volume attack** (acknowledged rule-shape limitation — spike-detection rule, not slow-drip detector; mitigated by per-keyid cap and application-layer detection), **onboarding-window-timed attack** (attacker rides publicly-announced raised-floor windows; human-review escalation during raised windows).
- Tuning-adjustments table.
- **"DO NOT publish" three-audience split**: public disclosure prohibited (attacker oracle), attested disclosure under NDA to auditors permitted (SOC 2 / ISO 27001 may require it), internal runbooks required (incident response needs the values). Replaces the prior too-absolute "never disclose" rule.

## Step 14b logging — Unicode-aware sanitization (SECURITY FIX)

Prior implementation used ASCII-only `< 0x20 || === 0x7F`. Security review flagged this reopens the log-injection channel the sanitization rule exists to close: bidi overrides (U+202E reverses terminal rendering), line/paragraph separators (U+2028/U+2029 render as line breaks, enabling row-injection), zero-width chars (U+200B-200D, invisible obfuscation), C1 controls (U+0080-009F, terminal control semantics), and BOM (U+FEFF, parser corruption) all passed through.

Fixed: `security.mdx` step 14b now normatively enumerates the minimum non-printable set (C0 controls, DEL, C1 controls, bidi controls and isolates, line/paragraph separators, zero-width characters, BOM) with rationale for each class. Implementations MAY extend to a broader Unicode non-printable classification but MUST NOT narrow it — an ASCII-only check is explicitly called out as non-conformant.

Reference signer in `tests/helpers/reference-webhook-signer.cjs` implements the correct Unicode-aware classification via `isNonPrintableCodepoint()`. Conformance tests in `tests/webhook-hmac-signer-conformance.test.cjs` unit-test every normative codepoint class (C0, DEL, C1, bidi, zero-width, line-sep, BOM) plus codepoint-boundary-safe UTF-8 truncation for multi-byte sequences (CJK, emoji, mixed-width).

## Signer-side conformance fixtures

`signer_side` top-level object in `webhook-hmac-sha256.json`:
- `action_values` enum defines `reject-input-before-sign` and `sign-and-emit`
- `rejection_vectors` covers four shape-classes: top-level, plain-nested, **array-contained** (real-world AdCP payload shape: `packages[]`, `creative_assets[]`, `events[]` — blind spot in hand-rolled walkers that recurse into object values but not array members), and **three-deep** (catches walkers with shallow fixed-depth bounds)
- `positive_vectors` has `signer-upstream-clean-input` so reject-everything signers cannot trivially pass

## In-repo conformance harness

Two test files now share a common helper:

**`tests/helpers/reference-webhook-signer.cjs`** — module exports `findDuplicateKeyNames`, `hasDuplicateKeyInAnyObjectScope` (delegates to the former), `isNonPrintableCodepoint`, `sanitizeKeyName`, `referenceSigner`. Carries an explicit CONTRACT BOUNDARY comment: the fixtures ARE the conformance contract; this file is one implementation; downstream SDK authors MUST match fixture behavior but MAY diverge in internal error-object shape. Comment also calls out that the duplicate-key tokenizer here is a test-time shortcut — production signers MUST use their language's strict-parse escape hatch per step 14a (Python `object_pairs_hook`, Node `stream-json`, Go `json.Decoder` token-walk or `goccy/go-json` with `DisallowDuplicateKey()`, Jackson `FAIL_ON_READING_DUP_TREE_KEY`, Ruby `Oj.load(strict_mode)`).

**`tests/webhook-hmac-vectors.test.cjs`** — keeps structural assertions, signature-computation tests, fixture-shape checks; imports `hasDuplicateKeyInAnyObjectScope` from the helper (removes the earlier duplicate walker).

**`tests/webhook-hmac-signer-conformance.test.cjs`** (new) — exercises `referenceSigner` against every `signer_side.rejection_vectors[i]` and `signer_side.positive_vectors[i]`. Asserts action matches `expected_signer_action`, rejection surfaces ≥1 sanitized key name capped at 4, positive signs MUST NOT carry an error field alongside the signed_frame, positive signatures verify against the test secret. Unit-tests `sanitizeKeyName` against ASCII controls, every normative Unicode non-printable class, UTF-8 codepoint-boundary truncation for CJK and emoji, and `isNonPrintableCodepoint` classification.

75 tests total (52 structural + 23 signer-conformance).

## What this close does NOT do

The spec language still says "interop harnesses MUST exercise both" and the reference signer is one implementation. Downstream SDK authors run their own signers against the fixtures as part of their own CI. This PR ships the fixtures, the reference implementation, and the in-repo enforcement path; it does not run external SDK CI on behalf of SDK authors.

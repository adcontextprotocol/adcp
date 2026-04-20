---
---

Five follow-ups to PR #2522's duplicate-key MUST-reject tightening, plus four rounds of expert review landing in one PR. Closes #2545, #2546, #2547, #2549, #2551.

## Admission-pressure — categories normative, numbers non-normative

`security.mdx` webhook replay dedup sizing specifies only the four **categories** (short-window ratio, medium-window ratio, long-window ratio, proportional ceiling) plus: thresholds MUST be operator-configurable; alarm payload MUST name the triggering clause; alarms SHOULD route to incident response not automatic revocation (auto-revocation is a DoS vector — legitimate onboarding can trip the alarm); **implementations SHOULD log/alarm a `threshold_tuning_overdue` event** when any threshold remains at its shipped starting value more than 30 days past first admission (gives the operator-tuning obligation a testable hook).

**Non-normative tuning guide** at `docs/building/implementation/webhook-verifier-tuning.mdx`:

- Starting-values table framed as starting points, not defaults
- **First-30-days oracle warning** — operators MUST tune within 30 days; implementations SHOULD randomize starting thresholds by **log-uniform distribution over [0.5×, 2×]** (4× fleet-wide spread) on first deployment. Narrower distributions (e.g., ±30% giving 1.86× spread) let a disciplined attacker stay under the entire fleet by tuning to 0.7× published.
- Baselining methodology
- **11 attack scenarios** (added: key-rotation storm, thin-history window, intermittent low-volume rule-shape limitation, onboarding-window-timed attack, baseline-reset-at-mature-verifier). Scenario 9 explicitly corrects the prior overstatement that the per-keyid and aggregate caps close slow-drip attacks — they don't; operators with that threat in scope MUST layer application-level detection.
- Tuning-adjustments table
- **"DO NOT publish" three-audience split**: public prohibited, NDA-attested to auditors permitted, internal runbooks required

## Step 14b logging — Unicode-aware sanitization (SECURITY FIX)

Prior implementation was ASCII-only (`< 0x20 || === 0x7F`). Security review flagged this reopened the log-injection channel: bidi overrides (U+202E reverses terminal rendering), line/paragraph separators (U+2028/U+2029 render as line breaks → row-injection), zero-width chars (U+200B–200D invisible obfuscation), C1 controls (U+0080–009F terminal control semantics), and BOM (U+FEFF parser corruption) all passed through.

`security.mdx` step 14b now normatively enumerates the minimum non-printable set with rationale for each class, structured as a three-bullet list for scannability: **(a)** first-non-printable truncation with `<sanitized:N>` placeholder, **(b)** 32-byte cap at last complete UTF-8 codepoint boundary, **(c)** count cap at 4. Implementations MAY extend the non-printable set but MUST NOT narrow it — ASCII-only is explicitly called out as non-conformant.

## Signer-side — error identifier normative, internals implementation-defined

Legacy HMAC clause now mandates: when a signer surfaces the rejection via an error, the error identifier (error-code string, exception class name, sum-type tag) MUST be `duplicate_key_input` exactly. This is the one cross-SDK-stable field so that multi-SDK integrations can write `if (error.code === 'duplicate_key_input') { ... }` and have the dispatch work regardless of which SDK signed. Internal shape of the error carrier is implementation-defined. The signer-conformance harness asserts this normatively against every rejection fixture.

## Signer-side conformance — fixtures + reference implementation + CI harness

`signer_side` top-level object in `webhook-hmac-sha256.json` with `action_values`, `rejection_vectors` (four shape-classes: top-level, plain-nested, array-contained, three-deep), and `positive_vectors` (clean-input case so reject-everything signers can't pass).

**Reference signer** at `tests/helpers/reference-webhook-signer.cjs` with explicit CONTRACT BOUNDARY comment — fixtures ARE the contract; reference signer is ONE implementation; error-object internals are implementation-defined (except the normative `code` string). Tokenizer called out as test-time shortcut; production signers MUST use strict-parse escape hatch per step 14a.

**In-repo enforcement** at `tests/webhook-hmac-signer-conformance.test.cjs` exercises the reference signer against every fixture. Asserts action match, `error.code === 'duplicate_key_input'`, sanitized-keys surfaced, cap-at-4, positive-vectors-MUST-NOT-carry-error (prevents ambiguous response shape), signatures verify. Unit-tests sanitization against every Unicode non-printable class and UTF-8 codepoint-boundary truncation (CJK, emoji, mixed-width).

Test file split: `webhook-hmac-vectors.test.cjs` (structural/signature) + `webhook-hmac-signer-conformance.test.cjs` (signer harness). 75 tests pass.

## Scope not in this PR

The spec still says "interop harnesses MUST exercise both" — this PR ships fixtures, reference implementation, and in-repo enforcement for the reference signer. External SDK authors run their own signers against the fixtures as part of their own CI; this PR does not run external SDK CI on their behalf.

---
---

Add a conformance test vector for the duplicate-object-key path in the legacy HMAC-SHA256 webhook scheme and tighten the accompanying normative guidance, making the "verifiers MAY reject bodies containing duplicate keys" clause from #2478 both testable and safer to implement.

**Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**
- New vector `duplicate-keys-conflicting-values` with `raw_body={"event":"creative.status_changed","creative_id":"creative_123","status":"approved","status":"rejected"}` and a correctly-computed HMAC. Uses conflicting values (not identical `"ok"`/`"ok"`) so the parser-differential attack surface the clause guards against is actually testable — the CVE-2017-12635 attack class that motivates the rule requires divergent values, not duplicates.
- New top-level `outcome_values` map defines the enum (`accept`, `reject-malformed`) and their semantics, so SDK conformance suites resolve tokens from a single source of truth rather than scraping description prose. `accept` explicitly includes deterministic last-wins/first-wins downstream JSON parsing.
- New top-level `non_conformant_outcomes` array names the actually-dangerous failure modes: silent accept with signature-verifier / business-logic parse divergence (the CVE class), and returning a signature-mismatch error for a body whose HMAC is mathematically valid (wrong error class — the signature IS valid; the failure is malformed-body).
- Per-vector fields: `acceptable_outcomes: ["accept", "reject-malformed"]` plus `recommended_outcome: "reject-malformed"` so SDKs have a spec-blessed default for spend-committing deployments.

**Spec (`docs/building/implementation/security.mdx`):**
- Promote the duplicate-keys clause to its own bullet (previously buried in "Non-canonicalized aspects"). Fix the RFC 8259 §4 wording — the RFC says names "SHOULD be unique" and that behavior with duplicates is "unpredictable," not strictly "undefined."
- Reference CVE-2017-12635 (CouchDB privilege escalation via duplicate `roles` key) as the historical precedent and attack-class anchor.
- Define both conformant verifier outcomes with their exact semantics, and explicitly call out that `reject-malformed` is SHOULD for state-change or spend-committing bodies (webhook callbacks, governance context, media-buy status transitions).
- Clarify the error-class split: `reject-malformed` is NOT a signature-mismatch error. The signature is valid; the body is malformed.
- Clarify the crash hierarchy: crash/fail-closed is conformant-but-suboptimal; verifiers SHOULD return a structured malformed-body error. The non-conformant outcome is silent accept with parser divergence between the signature verifier and downstream consumers.
- Flag that a future AdCP release will tighten this from MAY to MUST for state-change bodies; implementers SHOULD adopt `reject-malformed` now.

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Structural assertions: top-level `outcome_values` map present with both enum keys defined; `non_conformant_outcomes` non-empty. Every vector carrying `acceptable_outcomes` must be a non-duplicate subset of the enum, must list ≥2 outcomes, and must carry a `recommended_outcome` that is one of its acceptable values. Protects the conformance contract from typo-drift (a vector with `"reject-malform"` now fails CI instead of shipping silently).

Closes #2483. Follow-up: #2523 tracks tightening MAY → MUST for state-change payloads in a future release.

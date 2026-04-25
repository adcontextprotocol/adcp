---
---

patch: complete the signed-requests reclassification (specialism → universal capability-gated storyboard)

Follow-up patch to #3076 that completes the `signed-requests` reclassification flagged in #3075.

**File move:** `static/compliance/source/specialisms/signed-requests/index.yaml` → `static/compliance/source/universal/signed-requests.yaml`. Removed `protocol: media-buy` and `status: deprecated` (universal storyboards have neither — they're cross-protocol and inherent to the suite).

**Test-kit update:** `static/compliance/source/test-kits/signed-requests-runner.yaml` — `applies_to.specialism: signed-requests` → `applies_to.universal_storyboard: signed-requests`. Header comments and references field updated to point at the universal storyboard. Test-kit file path is unchanged (still `test-kits/signed-requests-runner.yaml`).

**Docs:** `docs/building/conformance.mdx` adds `signed_requests` to the universal-storyboards table, gated on `request_signing.supported: true` (mirrors `deterministic_testing` which is gated on `compliance_testing.supported: true`).

**Schema:** `static/schemas/source/enums/specialism.json` — `signed-requests` enum value retained for backward compatibility on a new `x-deprecated-enum-values` allowlist that the build-time parity check (`scripts/build-compliance.cjs verifyEnumParity`) respects. 4.0 enum removal tracked at #3078.

**Docs cross-link:** `docs/building/implementation/security.mdx` — Signed Requests (Transport Layer) section now points at the universal storyboard so readers landing on the implementation reference can find the conformance suite.

**Cross-references:** updated comments in `static/compliance/source/universal/storyboard-schema.yaml` (illustrative `applies_to` syntax now uses `universal_storyboard:` instead of `specialism:` example), `static/compliance/source/universal/runner-output-contract.yaml` ("specialisms" → "storyboards"), and `static/compliance/source/specialisms/governance-aware-seller/index.yaml` (notes the reclassification while keeping the example pattern relevant).

Why patch (per the rule established in #3076): conformance-suite changes version independently of spec, and this is a taxonomy reclassification that doesn't change what an agent must do on the wire. Sellers continue to advertise `request_signing.supported: true` and implement the verifier per the security profile; the runner now reaches them via the universal storyboard instead of the per-protocol specialism. No graded users today (the prior specialism was preview status). 28+ test vectors at `static/compliance/source/test-vectors/request-signing/` are unchanged and shared.

Closes #3075.

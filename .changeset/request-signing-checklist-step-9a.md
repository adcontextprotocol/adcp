---
"adcontextprotocol": patch
---

Clarify request-signing verifier checklist step ordering: the per-keyid replay-cache cap check is now formalized as **step 9a**, run after revocation (step 9) and **before** cryptographic verify (step 10). This makes conformance test vector `negative/020-rate-abuse.json` reproducible — previously the vector's expected outcome (`request_signature_rate_abuse`) was only producible when the cap check ran before crypto verify, but the checklist numbered the replay-related checks as step 12, *after* crypto verify at step 10. The cap-check ordering parallels revocation: both are cheap O(1) rejections that MUST run before crypto verify so an abusive or revoked signer cannot force amplified Ed25519/ECDSA work on the verifier. Step 12 (nonce dedup) still runs after crypto verify so the replay cache is not consumed by invalid signatures.

Updated files:

- `docs/building/implementation/security.mdx`: added step 9a to the verifier checklist, motivated its placement between step 7 (JWKS resolve) and step 10 (crypto verify) — after 7 so the cap-state oracle only responds for keys already published in JWKS, before 10 to prevent amplified crypto work. Split the rationale section into three paragraphs: the cheap-rejections argument, the load-bearing cap-write invariant (external traffic can't grow the cap because inserts happen at step 13 after crypto verify), and the step-12-runs-post-crypto note. Added a "Single-process vs. distributed enforcement" paragraph to the Transport replay dedup section noting that step 9a is a cheap amplification guard while step 13's insert should be atomic with a cap check to avoid drift on Redis-backed verifiers. Added `isKeyidAtCapacity` to the reference TypeScript verifier. Aligned the shadow-mode conformance bullet at line 701 with the error-code-only grading contract.
- `static/compliance/source/test-vectors/request-signing/negative/020-rate-abuse.json`: `failed_step` changed from `12` to `"9a"`, `spec_reference` now points at checklist step 9a, `$comment` explains the placeholder `Signature` bytes and why verifiers that defer the cap check until after crypto verify will fail this vector.
- `static/compliance/source/test-vectors/request-signing/README.md`: updated 020 description, extended the `failed_step` field definition to allow string sub-step labels, documented the `replay_cache_per_keyid_cap_hit` test-harness state key alongside `replay_cache_entries` and `revocation_list`, and added a "Stateful pre-crypto negatives" group to the recommended run order so `017` (revocation) and `020` (cap) are validated together, before crypto-dependent negatives.
- `static/compliance/source/specialisms/signed-requests/index.yaml`: replaced "13-step verifier checklist" with a reference to the 13 numbered steps plus sub-step 9a.

No wire-format change. This is a verifier-side implementation-order clarification. Signers are unaffected.

Reported as adcontextprotocol/adcp#2339. Surfaced by the Python SDK implementation at adcontextprotocol/adcp-client-python#183, where moving the cap check ahead of crypto verify produced the expected vector outcome without any vector edits.

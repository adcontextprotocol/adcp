---
"adcontextprotocol": patch
---

spec(compliance): define signed-requests-runner test-kit harness contract for stateful vectors (#2350)

The signed-requests specialism grades agents against 28 conformance vectors; three
negatives (016 replayed nonce, 017 key revoked, 020 per-keyid cap) assert verifier
state a black-box runner cannot inject. This change adds the coordination contract
a storyboard runner and an agent under test both read:

- New `static/compliance/source/test-kits/signed-requests-runner.yaml` (id
  `signed_requests_runner`) declaring the runner's signing keyids, a dedicated
  pre-revoked keyid for vector 017, the grading-time per-keyid cap the runner
  will target for vector 020 (distinct from the production minimum, also
  declared on the same block so implementers don't copy-paste the test cap),
  the minimum replay-cache TTL that keeps vector 016's repeat-request probe
  reliable, and the sandbox-endpoint scope (the replay contract's first
  request is a live, validly-signed mutating operation and MUST NOT be graded
  against production).
- New `test-revoked-2026` Ed25519 keypair in `keys.json` (adcp_use: request-signing)
  so vector 017 has a dedicated revoked key and does not conflict with either
  the purpose-mismatch vector (009, which uses `test-gov-2026`) or the runner's
  own signing key (`test-ed25519-2026`).
- Vector 017 updated to sign with `test-revoked-2026` and carry the
  revocation-list pre-state targeting that keyid; `$comment` expanded to call
  out that a crypto-first verifier will fail the vector by returning
  `request_signature_invalid` instead of `request_signature_key_revoked`.
- `requires_contract` field on vectors 016/017/020 (values `replay_window`,
  `revocation`, `rate_abuse`, matching the keys under
  `stateful_vector_contract` in the test-kit) so a runner can filter stateful
  vectors without hard-coding IDs.
- Specialism narrative updated to point at the test-kit, spell out the
  precondition expectation, and state that vectors with an unsatisfied
  `requires_contract` grade as FAIL, not SKIP.
- `TestKit` TS interface in `server/src/services/storyboards.ts` widened so
  harness-contract kits can load without lying about the shape (brand-identity
  kits remain structurally typed; only `id` is required at load time).

Pre-signed `Signature` bytes are unchanged in all vectors; black-box runners
re-sign dynamically, and the pre-signed bytes remain valid for white-box
cross-SDK byte-equivalence checks. Unblocks the smoke-test slice of
adcp-client#585.

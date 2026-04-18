---
"adcontextprotocol": patch
---

spec(compliance): define signed-requests-runner test-kit harness contract for stateful vectors (#2350)

The signed-requests specialism grades agents against 28 conformance vectors; three
negatives (016 replayed nonce, 017 key revoked, 020 per-keyid cap) assert verifier
state a black-box runner cannot inject. This change adds the coordination contract
a storyboard runner and an agent under test both read:

- New `static/compliance/source/test-kits/signed-requests-runner.yaml` declaring the
  runner's signing keyids, the pre-revoked keyid for vector 017, and the minimum
  per-keyid cap the runner will target for vector 020.
- New `test-revoked-2026` Ed25519 keypair in `keys.json` (adcp_use: request-signing)
  so vector 017 has a dedicated revoked key and does not conflict with either the
  purpose-mismatch vector (009, which uses `test-gov-2026`) or the runner's own
  signing key (`test-ed25519-2026`).
- Vector 017 updated to sign with `test-revoked-2026` and carry the revocation-list
  pre-state targeting that keyid.
- `harness_mode_required` field on vectors 016/017/020 so a runner can filter
  stateful vectors without hard-coding IDs: `replay_window_contract`,
  `revocation_contract`, `rate_abuse_contract`.
- Specialism narrative updated to point at the test-kit and spell out the
  precondition expectation.

Pre-signed `Signature` bytes are unchanged in all vectors; black-box runners
re-sign dynamically, and the pre-signed bytes remain valid for white-box
cross-SDK byte-equivalence checks. Unblocks the smoke-test slice of
adcp-client#585.

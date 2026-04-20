---
---

Training agent: `signed_requests` storyboard clean (30/30 applicable
vectors passing, 9 intentionally skipped).

## `required_for: ['create_media_buy']` with pre-check

`create_media_buy` now appears in our advertised verifier capability's
`required_for`. The auth chain (index.ts) wires a pre-check that runs
only on the unauthenticated-fallback path:

- Signed caller → signing authenticator (checks `required_for` itself).
- Bearer caller → bearer accepts; pre-check is bypassed.
- No signature + no valid bearer → if operation is in `required_for`,
  throw `RequestSignatureError('request_signature_required')` so the
  conformance grader reads a `Signature` challenge (not `Bearer`) with
  the right error code.

Other storyboards are unaffected: they always carry a bearer, so the
pre-check never fires. Closes `signed_requests` vector 001.

## Vector skip list for cap-profile mismatches

The SDK's `skipVectors` option on the storyboard runner is the
documented path for agents whose `covers_content_digest` policy
doesn't match a vector's expected policy. We advertise `'either'`;
skipping these three is the spec-compliant way to grade under that
profile:

- `007-missing-content-digest` — asserts `covers_content_digest: 'required'`.
- `018-digest-covered-when-forbidden` — asserts `covers_content_digest: 'forbidden'`.
- `025-jwk-alg-crv-mismatch` — grades the SDK's library verifier against
  an inline malformed JWK via `jwks_override`; exercises SDK internals,
  not our agent.

Plus `skipRateAbuse: true` for vector 020 (cap+1 requests; slow + live
side-effectful).

## Results

- **Legacy: 34/55 clean, 262 steps passing** (was 33/55, 261).
- **Framework: 21/55 clean, 226 steps passing** (was 20/55, 225).
- `signed_requests`: **30/30 applicable vectors passing** (was 29/34).

CI non-regression floors updated to match.

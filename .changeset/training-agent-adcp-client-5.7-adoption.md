---
---

Training agent: adopt `@adcp/client` 5.7 auth helpers, drop local
workaround files.

## What 5.7 shipped that we adopted

- **`requireAuthenticatedOrSigned({ signature, fallback, requiredFor, resolveOperation })`**
  — the SDK's presence-gated composition with `required_for` enforcement
  on the no-signature path. Replaces `server/src/training-agent/strict-auth.ts`
  (deleted) that we wrote to work around the gap in 5.6. `required_for`
  now fires correctly when the fallback throws (bad bearer), which closes
  the edge case that was leaving signed_requests vector 011
  (`request_signature_header_malformed`) failing with the wrong error
  code.
- **`signatureErrorCodeFromCause(err)` + `respondUnauthorized({ signatureError })`**
  — SDK unwraps the RFC 9421 error from `AuthError.cause` and emits
  `WWW-Authenticate: Signature error="<code>"` automatically. Replaces
  ~20 lines of hand-rolled challenge emission in `requireToken`.

## Error-code fix

`handleUpdateMediaBuy` double-cancel guard emitted `INVALID_STATE_TRANSITION`
— a drift code that doesn't appear in any enum (only in 5 prose lines of
`state-machine.yaml` that PR adcp#2596 fixes). Canonical seller enum is
`INVALID_STATE` (distinct from the controller-specific `INVALID_TRANSITION`
in `comply-test-controller-response.json`). Corrected.

## Results

- **Legacy: 37/55 clean, 282 steps passing** (was 35/55, 279).
- **Framework: 23/55 clean, 240 steps passing** (was 21/55, 237).
- **`signed_requests` back to 30/30 clean** — vector 011 no longer falls
  through to the `required_for` pre-check; `requireAuthenticatedOrSigned`
  composition dispatches to the signing authenticator first and surfaces
  `request_signature_header_malformed` as the challenge error code.

CI non-regression floors updated to match.

---
---

Training agent: upgrade to `@adcp/client` 5.5 and compose RFC 9421 request
signing into the `anyOf` auth chain.

5.5 adds `verifySignatureAsAuthenticator`, which lets a signature verifier
sit alongside `verifyApiKey` under `anyOf(...)` — so the endpoint accepts
either a valid bearer token OR a valid RFC 9421 signature, and neither
short-circuits the other. This closes the "signed-but-bearerless" gap the
5.4 notes flagged as a follow-up.

## What changed in this repo

- **`request-signing.ts`**: rewritten as
  `buildRequestSigningAuthenticator()` returning an `Authenticator` instead
  of an Express middleware. `getUrl` override reconstructs the signed path
  from `req.originalUrl` because Express strips the `/api/training-agent`
  mount prefix from `req.url` before the authenticator runs.
- **`index.ts`**: signing authenticator joins the `anyOf(...)` chain next
  to `verifyApiKey`. Old `requestSigningMiddleware` wiring is removed.
- **`framework-server.ts`**: adds `capabilities.overrides` for
  training-agent-specific surface (publisher portfolio,
  `compliance_testing.scenarios`, targeting surface) now that 5.5 supports
  per-domain merge over the framework's auto-derived response.
- **Storyboard runners**: `express.json({ verify })` captures `rawBody`
  bytes so the in-process verifier rehashes exactly what the signer
  signed.

## Results

- **437/437 unit + integration tests green** with the framework flag OFF.
- **29/55 storyboards clean** on the legacy path (+4 over 5.3 baseline —
  the signing compose closes the last bearer-gate blocker on
  `signed_requests` positive vectors).
- Framework flag stays OFF by default: flipping it to ON regresses 10
  storyboards to 19/55 due to the framework's stricter zod argument
  validation rejecting shapes our handlers still accept. Tracked as a
  separate follow-up — 5.5's SDK surface is in place, legacy path remains
  authoritative until framework parity is triaged.

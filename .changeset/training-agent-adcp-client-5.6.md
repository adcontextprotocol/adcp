---
---

Training agent: upgrade to `@adcp/client` 5.6 and drop the local
presence-gated auth wrapper.

5.6 ships `requireSignatureWhenPresent(signatureAuth, fallbackAuth)`
([adcp-client#659](https://github.com/adcontextprotocol/adcp-client/pull/659)) —
the spec-compliant helper we requested. Replaces the local wrapper in
`buildAuthenticator` with the SDK version. The SDK implementation also
detects a solo `Signature` header (without `Signature-Input`) which our
naïve `req.headers['signature-input']` check missed — closes one more
`signed_requests` negative vector we were silently accepting.

Composition guard: `requireSignatureWhenPresent` tags its result
`AUTH_PRESENCE_GATED`, so `anyOf` refuses to wrap it at setup time and
the bypass the gate exists to prevent can't accidentally reopen. The
documented composition order is
`requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))` — our code
already matches.

## Results

- **Legacy path: 33/55 clean, 261 steps passing** (was 32/55, 256).
- **Framework path: 20/55 clean, 225 steps passing** (was 19/55, 216).
- `signed_requests`: 29/34 steps passing (was 28). Remaining 5 need
  capability/test-kit coordination the vectors assert against (e.g.
  `required_for: [create_media_buy]` conflicts with other storyboards
  that send unsigned mutating requests).

CI non-regression floors updated to match.

---
---

feat(training-agent): mount /<tenant>/mcp-strict-required + /<tenant>/mcp-strict-forbidden, route signed_requests at all three

The `signed_requests` conformance storyboard skipped 9 vectors per tenant: 4 explicit
(`skipVectors`: 007/018/025 + `skipRateAbuse` for 020) and 5 capability-incompatible
because the existing `/<tenant>/mcp-strict` route advertises `covers_content_digest: 'either'`,
causing the grader to skip vectors that require `'required'` or `'forbidden'` profiles.

The authenticators and capabilities for the two new profiles were already implemented in
`request-signing.ts` (`buildStrictRequiredRequestSigningAuthenticator` /
`buildStrictForbiddenRequestSigningAuthenticator`). This PR mounts the corresponding routes
and routes the storyboard runner at all three.

Changes:
- `server/src/training-agent/index.ts`: adds lazy auth singletons, authenticator builders,
  `requireToken` middleware, and route mounts for `/<tenant>/mcp-strict-required` and
  `/<tenant>/mcp-strict-forbidden` following the exact pattern of `/<tenant>/mcp-strict`.
  Refactors `strictMcpHandler` into `makeStrictMcpHandler(digestMode?)` factory to avoid
  duplication across the three variants.
- `server/tests/manual/run-storyboards.ts`: replaces the single `signed_requests → /mcp-strict`
  run with a 3-variant loop (one per route). Per-route `skipVectors` assignments:
  `/mcp-strict` keeps 007/018/025; `/mcp-strict-required` drops 007 (now passes); 
  `/mcp-strict-forbidden` drops 018 (now passes).

Coverage lift per tenant:
| Tenant           | Before  | After   | Δ      |
|------------------|---------|---------|--------|
| signed_requests  | 31P/9S  | 36P/4S  | +5/-5  |

Across all six tenants: +30 steps recovered. Closes #4096.

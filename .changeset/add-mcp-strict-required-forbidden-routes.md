---
---

feat(training-agent): add /mcp-strict-required and /mcp-strict-forbidden conformance routes

Adds two grader-targeted MCP routes that expose `covers_content_digest='required'` and `'forbidden'` modes for the request-signing conformance grader:

- `/mcp-strict-required` — advertises and enforces `covers_content_digest: 'required'`. Enables grader vector neg/007 (`missing-content-digest`): rejects signatures that omit content-digest coverage.
- `/mcp-strict-forbidden` — advertises and enforces `covers_content_digest: 'forbidden'`. Enables grader vector neg/018 (`digest-covered-when-forbidden`): rejects signatures that include content-digest coverage.

Previously, `/mcp-strict` advertised `'either'` (correct for the sandbox) so neg/007 and neg/018 could never fire — the verifier correctly accepted both probe shapes, leaving buyers with no endpoint to test required-mode and forbidden-mode rejection paths.

**Implementation:** refactors the internal `buildStrictAuthenticator` into a `buildStrictModeAuthenticator(lazyAuth)` factory that accepts a lazy signing authenticator, allowing each route to hold its own capability instance baked at init time (per-request capability swap is unsafe because `verifySignatureAsAuthenticator` captures the capability at construction). Adds `digestMode` to `TrainingContext` so `selectSigningCapability(ctx)` can pick the right capability for the `get_adcp_capabilities` advertisement.

Server-only change. No schema modifications. Closes #3339.

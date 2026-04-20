---
---

Training agent: presence-gated signature composition + review polish.

## Signed-requests composition fix

Replaces the `anyOf(verifyApiKey, verifySignatureAsAuthenticator)` chain
(which accepted invalid signatures when a valid bearer was also present —
25 storyboard steps failed on negative vectors) with a presence-gated
wrapper:

- If `Signature-Input` header present → signature MUST verify; throws
  propagate to `requireToken` and emit `WWW-Authenticate: Signature
  error="<spec-code>"` so the conformance grader can read the error code.
- If no `Signature-Input` → bearer chain.

Closes 19 `signed_requests` storyboard steps (34/28 passing, up from
34/9). The remaining 6 need `required_for` coordination that the test kit
owns — tracked separately. Filed upstream as
[adcp-client#659](https://github.com/adcontextprotocol/adcp-client/issues/659)
for a spec-level `requireSignatureWhenPresent` helper.

## Review polish

Addresses the OAuth workstream review of #2561:

- **HIGH — real zod `inputSchema` on all 9 custom tools** (was
  `{ _passthrough: z.any().optional() }` which published a wrong contract
  via `tools/list`). Publishes real arg shapes to MCP clients; handlers
  still own semantic validation. Closes 34 framework-path storyboard
  steps blocked by the placeholder schema.
- **MEDIUM — eager signing authenticator init** at router creation so
  missing/corrupt compliance JWKS fail loud at boot rather than surfacing
  as an opaque 401.
- **MEDIUM — rename `verifySignatureAsAuthenticator_`** →
  `lazySigningAuthenticator` (the underscore suffix shadowed the SDK
  export of the same name).
- **MEDIUM — idempotency scoping comment** explaining why only
  `static:public` is account-scoped.
- **MEDIUM — `useFrameworkServer` jsdoc** now matches code (default OFF).
- **LOW — demote per-request `Framework training agent server
  constructed`** log to debug (runs on every HTTP request on stateless
  transport).
- **LOW — drop stale "Stage 2" comment**.

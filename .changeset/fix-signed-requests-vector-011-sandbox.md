---
---

Training agent: close signed-requests vector 011 on the sandbox `/mcp`
route.

Vector 011 (`negative/011-malformed-header.json`) sends a syntactically
invalid `Signature-Input` header and requires the verifier to fail closed
with `request_signature_header_malformed`. The sandbox route previously
composed `anyOf(bearerAuth, signing)`, which caught the parser error and
silently fell through to bearer — the exact downgrade the spec pre-check
was written to prevent.

Fix: swap the composition to
`requireSignatureWhenPresent(signing, bearerAuth)` (shipped in
`@adcp/client` 5.7, `src/lib/server/auth-signature.ts:314`). Callers with
no `Signature-Input` header still fall through to bearer unchanged
(sandbox AAO API keys keep working); callers that DO present a signature
header now run the signing authenticator as the sole path and malformed
headers 401 with the correct error code.

Unrelated to the webhook-auth downgrade rule, which remains enforced
only on `/mcp-strict` per `security.mdx#webhook-callbacks`.

Added integration coverage in `training-agent-strict.test.ts` for the
vector-011 shape (malformed Signature-Input + valid bearer → 401).

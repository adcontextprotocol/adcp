---
---

AAO-hosted adagents.json documents now carry an `_aao_envelope` field
with an Ed25519-signed JWS attesting AAO provenance. Closes #4110.

The TLS chain on `aao.scope3.com/publisher/{domain}/.well-known/adagents.json`
ends at AAO rather than the publisher, which strict buy-side verifiers
treat as a soft trust signal. The envelope adds a second attestation
channel: AAO signs the document body with a published key, so a
verifier with AAO's JWKS can confirm provenance independently of TLS.

Envelope shape:

```json
{
  "authorized_agents": [...],
  "properties": [...],
  "_aao_envelope": {
    "jws": "<compact JWT — payload IS the canonical document body>",
    "key_id": "aao-document-1",
    "issued_at": "2026-05-05T00:00:00Z",
    "expires_at": "2026-05-12T00:00:00Z",
    "publisher_domain": "example.com",
    "verification": "Decode the JWS; payload is canonical; verify against /.well-known/jwks.json (kid=aao-document-1, adcp_use=aao-document-signing); confirm iss/aud/sub."
  }
}
```

Verifier recipe: decode `envelope.jws`, treat its JWT payload as the
canonical document, verify the signature against the JWKS at
`/.well-known/jwks.json` (kid=`aao-document-1`,
adcp_use=`aao-document-signing`), confirm `iss=https://aao.org`,
`aud=aao-hosted-adagents`, `sub` matches the publisher_domain in the
URL.

New env vars (Fly secrets in production):

- `AAO_DOCUMENT_SIGNING_PRIVATE_KEY` — base64-encoded PKCS8 PEM, Ed25519
- `AAO_DOCUMENT_SIGNING_PUBLIC_KEY` — base64-encoded SPKI PEM, Ed25519

When unset, hosted documents are served unsigned (existing behaviour) —
the route falls through gracefully so dev / non-signing deployments
continue to work.

The published JWKS at `/.well-known/jwks.json` now lists three keys
(request-signing, webhook-signing, aao-document-signing) when the
envelope key is configured. Otherwise it lists the existing two.

Origin verification (#4109) is the next step — AAO-signed envelope
attests AAO hosts the document; origin verification will let us promote
the corresponding `agent_publisher_authorizations` rows from
`source='aao_hosted'` to `source='adagents_json'` once the publisher's
own /.well-known confirms the redirect.

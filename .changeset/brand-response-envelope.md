---
"adcontextprotocol": minor
---

Define the designated-task response payload JWS envelope for Brand Protocol verification responses.

`verify_brand_claim` and `verify_brand_claims` success schemas now require `signed_response`, binding the signed task body to the designated task, resolved brand tenant, responding agent URL, request hash, and `iat`/`exp` freshness window. The security and brand-agent docs specify ordinary JWS signing input over JCS-canonicalized payloads, response-signing JWK verification requirements, per-brand response-signing key separation, and bulk audit retention requirements.

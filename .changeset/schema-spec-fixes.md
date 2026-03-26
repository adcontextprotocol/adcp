---
"adcontextprotocol": minor
---

Remove `oneOf` from `get-products-request.json` and `build-creative-request.json` to fix code generation issues across TypeScript, Python, and Go. Conditional field validity is documented in field descriptions and validated in application logic.

Fix webhook HMAC verification contradictions between `security.mdx` and `webhooks.mdx`. `security.mdx` now references `webhooks.mdx` as the normative source and adds guidance on verification order, secret rotation, and SSRF prevention. Three adversarial test vectors added.

Localize `tagline` in `brand.json` and `get-brand-identity-response.json` — accepts a plain string (backwards compatible) or a localized array keyed by BCP 47 locale codes. Update `localized_name` definition to reference BCP 47 codes. Examples updated to use region-specific locale codes.

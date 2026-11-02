---
"adcontextprotocol": patch
---

Name repeated scalar subschemas (#8525). The currency code, country code, idempotency key, domain name, and HTTPS URL each move into a titled `core/` document, and the sites that stated them inline now `$ref` that document. Each site keeps its own `description` and other annotations. No document's accepted set changes: `npm run test:schema-extraction` resolves every added `$ref` and compares the result with the base document.

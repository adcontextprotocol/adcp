---
"adcontextprotocol": patch
---

Name repeated scalar subschemas (#8525). The currency code, country code, idempotency key, domain name, and HTTPS URL each move into a titled `core/` document, and the sites that stated them inline now `$ref` that document. Each site keeps its own `description` and other annotations. The same applies to the other scalar concepts that repeat across documents, such as digests, versions, geographic codes, and entity identifiers. A site moves only when the sites provably mean one concept and state identical constraints; the pull request lists the sites held apart. No document's accepted set changes: `npm run test:schema-extraction` resolves every added `$ref` and compares the result with the base document.

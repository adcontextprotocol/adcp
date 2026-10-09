---
"adcontextprotocol": patch
---

Add request-signing conformance vectors for three step-1 rules the corpus did not grade (adcp#7905). `negative/029` rejects a duplicate `sig1` label on the `Signature` header (RFC 9421 §4.2, RFC 8941 §3.2). `negative/030` rejects `Content-Digest: SHA-256=…, sha-256=…`: `SHA-256` is a parse-invalid dictionary key under RFC 8941 §3.1.2, and verifiers must not fold case. `negative/031` rejects an unbracketed IPv6 `Host` header (`::1`) with `request_target_uri_malformed` at step 10; it carries a real signature over the URL authority so the header is the only fault. Adds three false-positive guards, `positive/013` (distinct `sig1`/`sig2` labels), `014` (`sha-256` + `sha-512`) and `015` (`Host: [2001:db8::1]:8443`). No new requirement; the profile-3.2 mirrors follow in adcp#7733.

Correction to `negative/026-non-ascii-host`: its expected outcome changes from `request_signature_header_malformed` (step 1) to `request_target_uri_malformed` (step 10), aligning the vector with the `security.mdx` error table and `canonicalization.json`, which map a raw non-ASCII host to `request_target_uri_malformed`. The vector now also carries a real Ed25519 signature over the A-label base so the host is its only fault. Verifiers that matched the old code to pass 026 must update.

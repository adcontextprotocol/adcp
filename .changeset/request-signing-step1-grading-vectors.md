---
"adcontextprotocol": patch
---

Add request-signing conformance vectors for three step-1 rules the corpus did not grade (adcp#7905). `negative/029` rejects a duplicate `sig1` label on the `Signature` header (RFC 9421 §4.2, RFC 8941 §3.2). `negative/030` rejects `Content-Digest: SHA-256=…, sha-256=…`: `SHA-256` is a parse-invalid dictionary key under RFC 8941 §3.1.2, and verifiers must not fold case. `negative/031` rejects an unbracketed IPv6 `Host` header (`::1`) with `request_target_uri_malformed` at step 10; it carries a real signature over the URL authority so the header is the only fault. Adds three false-positive guards, `positive/013` (distinct `sig1`/`sig2` labels), `014` (`sha-256` + `sha-512`) and `015` (`Host: [2001:db8::1]:8443`). No new requirement; the profile-3.2 mirrors follow in adcp#7733.

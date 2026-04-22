---
---

Two docs clarifications from an external spec review:

- **SSRF pin-connection guidance** (`docs/building/implementation/security.mdx`): reorder the two MUST options so (a) connect-by-validated-IP is the preferred path and (b) post-handshake peer check is an explicit fallback, with a note that (b) depends on a client-library peer-address hook that fires before the first body byte — many libraries do not expose this, so implementations choosing (b) must verify the hook in testing. Normative strength unchanged (still MUST); this closes an implementation footgun where (b) was read as equal-weight to (a).
- **Governance context row in release notes** (`docs/reference/release-notes.mdx`): "Opaque `governance_context` string" was misleading without the signed-JWS qualifier. Now reads "Signed-JWS `governance_context` string (opaque to forwarders, cryptographically verifiable by auditors)" with an anchor to the normative JWS profile.

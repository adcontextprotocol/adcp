---
"adcontextprotocol": minor
---

Require every AdCP 3.2 request signature on a body-bearing request to cover `content-digest`, retain legacy digest modes only for 3.0/3.1 compatibility, migrate 3.2 request `Signature` and `Content-Digest` binary fields from the legacy Base64URL override to RFC 8941 padded Base64 while keeping webhook v1 on its explicitly routed legacy encoding throughout 3.x, add versioned body-substitution conformance coverage, and reject non-canonical release versions with leading zeros or malformed prerelease suffixes across AdCP version-negotiation surfaces.

The external signed-request storyboard remains explicitly 3.1-compatible until profile-aware vector selection lands; repository CI provides the 3.2 body-integrity coverage in the interim.

---
"adcontextprotocol": patch
---

Add 3 positive + 6 negative RFC 9421 request-signing conformance vectors covering: unreserved percent-decoding (%7E/%2D/%5F/%2E), reserved %2F preservation, IPv6 authority bracket handling, duplicate Signature-Input labels, multi-valued Content-Type/Content-Digest, unquoted sig-param strings, JWK alg/crv mismatch, and raw IDN U-label hosts.

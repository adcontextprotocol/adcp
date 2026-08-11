---
"adcontextprotocol": patch
---

Remove hard-coded request-signing conformance vector counts from the compliance runner header and request-signing documentation. The examples now cover both vector directories without totals and explicitly supply matching local vector and key inputs instead of relying on package-internal cache paths. This changes only protocol comments and documentation, not schemas or runner behavior; documentation drift linting and its regression tests are also hardened to preserve the corrected CLI guidance.

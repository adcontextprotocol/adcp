---
"adcontextprotocol": patch
---

Give all 37 routed request-signing conformance vectors operation-valid bodies so payload parsing can reach the signature verifier. Preserve every intended negative outcome, capability, URL and signature parameter. Recompute truthful digests and test signatures only for the two body-bound fixtures using the existing published fixture key and maintained wire encoding; no signing policy or release assets change (#7959, #7567).

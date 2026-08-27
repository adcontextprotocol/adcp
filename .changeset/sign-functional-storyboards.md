---
"adcontextprotocol": patch
---

Define capability-driven RFC 9421 signing for sandbox functional storyboard
dispatch. Runners reuse the existing published compliance key, sign operations
advertised in `request_signing.required_for` or `supported_for`, preserve bearer
authentication, and never bypass seller verification or retry unsigned after a
signer failure.

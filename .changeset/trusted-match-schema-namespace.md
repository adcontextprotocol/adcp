---
"adcontextprotocol": patch
---

Rename the canonical Trusted Match schema source directory from `tmp` to `trusted-match`, update registry references and examples to the self-describing path, and add schema discovery metadata for protocol layers plus prerelease supersession. Hosted schema routing keeps legacy `/schemas/{version}/tmp/...` URLs working by falling back to the canonical `trusted-match` files when a historical `tmp` artifact is not present.

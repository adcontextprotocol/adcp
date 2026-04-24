---
---

Add RFC 9421 request signing guide: new `docs/building/implementation/request-signing.mdx` covering key generation, JWKS/brand.json publication, buyer-side signing, seller-side verification with `requireAuthenticatedOrSigned` + `mcpToolNameResolver`, webhook signing, key rotation, and conformance testing (39 vectors: 12 positive, 27 negative). Adds a Request Signing section to `build-an-agent.mdx` and cross-links from the `security.mdx` quickstart. Ported from adcontextprotocol/adcp-client#914.

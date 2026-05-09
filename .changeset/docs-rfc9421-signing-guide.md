---
---

Add RFC 9421 request signing guide at `docs/building/by-layer/L1/request-signing.mdx`. Covers key generation, JWKS/brand.json publication, buyer-side signing, seller-side verification with `requireAuthenticatedOrSigned` + `mcpToolNameResolver`, webhook signing, key rotation, capability declaration, and conformance testing (39 vectors: 12 positive, 27 negative). Code examples in **JavaScript/TypeScript**, **Python** (`adcp.signing`), and **Go** (`adcp-go/adcp/signing`) tabs across all major steps. Storage section covers cloud KMS as the preferred option for spend-committing agents. Adds the page to the L1 nav in `docs.json` and a redirect from the legacy `/docs/building/implementation/request-signing` path. Ported from adcontextprotocol/adcp-client#914.

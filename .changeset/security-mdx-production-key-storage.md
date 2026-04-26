---
---

docs(security): add Production key storage subsection to RFC 9421 request-signing guidance

Adds a brief subsection at `docs/building/implementation/security.mdx` recommending KMS / HSM / Vault for production private-key storage on RFC 9421 transport-layer signing. Includes implementation notes for adapter authors (DER → IEEE P1363 conversion for ECDSA-P256, single-purpose key policy to avoid cross-protocol oracles) and points at the `@adcp/client` reference implementations.

The spec stays implementation-agnostic about where private keys live — only the bytes on the wire matter — but operator guidance on production key storage is a natural fit for the existing implementation guide.

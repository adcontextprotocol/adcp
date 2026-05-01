---
---

Add `specs/capabilities-brand-url.md` proposing a top-level `brand_url` on `get_adcp_capabilities` so verifiers can bootstrap from an agent URL to the operator's brand.json (and from there to signing keys) without out-of-band knowledge. Includes verifier algorithm with eTLD+1 origin binding + mandatory `identity.key_origins` consistency check, multi-tenant operator handling via `authorized_operators[]`, and a per-process resolver shipping in `@adcp/client` (TypeScript) and `adcp` (Python) with a `npx @adcp/client resolve <url>` CLI. No hosted AAO endpoint — centralized fetch of caller-supplied URLs is the wrong shape (SSRF amplification, centralized cache poisoning, AAO de facto in trust chain). No protocol changes ship in this PR — spec only.

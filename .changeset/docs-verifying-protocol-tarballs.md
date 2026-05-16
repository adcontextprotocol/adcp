---
---

Add `docs/reference/verifying-protocol-tarballs.mdx` covering the cosign keyless trust model for AdCP protocol bundles, the recommended `cosign verify-blob` invocation, and a cert-subject-by-release lookup.

Updated `docs/building/schemas-and-sdks.mdx` to use the canonical `refs/(heads|tags)/.*` regex (was `refs/heads/.*`) and link to the new doc.

The new doc explains why the regex needs to be a wildcard rather than a literal branch list — the AdCP release workflow's own `on.push.branches` allowlist is what gates which refs can produce a signature, so mirroring that list in every consumer's regex was a maintenance liability that silently broke v3.0.1+ verification when the 3.0.x maintenance branch was cut.

Companion fixes in the SDKs:
- `adcp-client` (TS): regex broadened from `(main|2\.6\.x)` literal — adcontextprotocol/adcp-client#1243
- `adcp-client-python`: `refs/heads/.*` → `refs/(heads|tags)/.*` for forward-compat — adcontextprotocol/adcp-client-python#343
- `adcp-go`: already on the canonical pattern, no change needed

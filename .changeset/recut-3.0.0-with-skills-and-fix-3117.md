---
---

Re-cut `/protocol/3.0.0.tgz` with `skills/` bundled (closes #3116) and replace hardcoded `dist/schemas/` paths in `skills/call-adcp-agent/SKILL.md` and `docs/protocol/calling-an-agent.mdx` with discovery-first phrasing (closes #3117).

**What this means for SDK consumers**

- Next `npm run sync-schemas` (or equivalent) against `ADCP_VERSION=3.0.0` will extract 7 protocol-managed skills under your local skills cache. No code changes required on your side.
- The published `/protocol/3.0.0.tgz` artifact at the same URL has a **new SHA-256**. If you cache the digest in a lockfile, CI artifact, or supply-chain attestation, refresh it after the deploy lands.
- **Cosign sidecars (`.sig` + `.crt`) for `3.0.0.tgz` are temporarily absent.** The original sidecars bound to the pre-skills SHA, so they were removed to keep verification consistent. Sync verification falls back to checksum-only trust on the 404 (graceful — logs `ℹ️  No cosign sidecars for v3.0.0`). Sidecars regenerate on the next CI release run; if you require Sigstore verification today, pin to the next release version once available.

The published bundle was built **2026-04-22**, before #3097 hoisted `skills/` into it. Same `adcp_version: "3.0.0"` is preserved — no SDK pin bumps required. CDN cache should be invalidated for `/protocol/3.0.0.tgz`, `/protocol/3.0.0.tgz.sha256`, `/protocol/3.0.0.tgz.sig`, `/protocol/3.0.0.tgz.crt` post-merge.

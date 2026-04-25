---
---

Re-cut `/protocol/3.0.0.tgz` with `skills/` bundled (closes #3116) and replace hardcoded `dist/schemas/` paths in `skills/call-adcp-agent/SKILL.md` and `docs/protocol/calling-an-agent.mdx` with discovery-first phrasing that doesn't assume a specific SDK layout (closes #3117).

The published `3.0.0.tgz` was built before #3097, so SDKs pinned to `ADCP_VERSION=3.0.0` extracted zero skills. Same `adcp_version: "3.0.0"` is preserved — no SDK pin bumps required. Stale cosign sidecars (`.sig` / `.crt`) deleted; sync verification falls back to checksum-only trust until the next CI release run regenerates them with the workflow identity.

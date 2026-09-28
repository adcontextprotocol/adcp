---
"adcontextprotocol": patch
---

Complete the 3.1 to 3.2 upgrade guide. This is a documentation-only change with no schema or normative-rule changes.

- `versioning.mdx`: reconcile the 3.x stability guarantees with 3.2. A new "3.2 exceptions to 3.x compatibility" section lists every exception: the ratified `status` removal, the request-signing profile correction, eight tightened request rules, and three producer-side tightenings. It also adds non-normative guidance for serving an older negotiated release; #7718 tracks the normative gap.
- `3-1-to-3-2.mdx`: add the following sections:
  - compatibility exceptions
  - mixed-version request signing (the endpoint, not the request pin, selects the signing profile)
  - a buyer and seller version-negotiation matrix
  - MediaBuy-level frequency caps, Reliable Reporting, authenticated principals, and the new sales specialisms
  - an SDK version map with links to each SDK's upgrade guide
  - day-one checklists by role
  - a verified wire-change table from 3.1.24 to 3.2
- Migration index: make it a hub that leads with 3.1 to 3.2.
- L2 authentication and security-model pages: align with the canonical L1 signing timeline. Signing is optional and capability-gated in 3.x, `content-digest`-bound when used in 3.2, and required for spend-committing operations in 4.0. This replaces an incorrect "required in 3.1+ / Bearer prohibited" claim.
- Correct stale facts:
  - Python `adcp==8.0.0b18` embeds RC.7 (also in `3-2-beta.mdx` and `intro.mdx`).
  - The missing 3.1.24 row.
  - The RC.3 tarball reference.
  - The unmerged `cache_namespace` claim (#7446).
  - Broken `schemas-and-sdks` anchors.

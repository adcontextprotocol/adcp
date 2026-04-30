---
---

dashboard(verification-panel): per-version badge rows. Stage 4 of #3524.

The verification panel on the per-agent compliance card now renders one row per `(role, adcp_version)`. An agent that holds both `media-buy@3.0 (Spec)` and `media-buy@3.1 (Spec + Live)` shows both rows, ordered by version descending so the newest is at the top. Each row carries:

- The version segment in the rendered label: `Media Buy Agent 3.1 (Spec + Live)` instead of `Media Buy Agent (Spec + Live)`.
- A version-pinned badge SVG URL inline (`/badge/{role}/{version}.svg`) so the displayed image is exactly the version that row represents.
- Embed snippets (HTML + Markdown) that point at the version-pinned URL with version-aware alt text. Buyers who want to call out "verified for AdCP 3.0" copy the row matching that version; buyers who want auto-upgrading copy the legacy `/badge/{role}.svg` URL embedded by older code.
- A stable drawer ID keyed on `role + version + index` so re-renders after an issue/revoke don't randomize the open/closed state of an already-expanded drawer.

API change: `GET /api/registry/agents/{url}/compliance` now includes `adcp_version` on each `verified_badges[]` entry. The schema description spells out the contract: it's the load-bearing badge identity field, paired with `(agent_url, role, adcp_version)` PK, and clients derive version-pinned SVG URLs from it client-side. The legacy `badge_url` field stays for backward compat and continues to auto-upgrade to the highest active version.

Defensive: panel JS validates the API's `adcp_version` against the same shape regex the SVG renderer uses (`^[1-9][0-9]*\.[0-9]+$`). A malformed value drops to legacy URL + version-less label rather than failing the row — same policy as `renderBadgeSvg`. The DB CHECK constraint and JWT signer regex prevent malformed values from reaching here in production paths, so this is belt-and-suspenders.

Verified live in the dashboard with seeded parallel-version badges. Verified in playwright that the embed drawer's HTML and Markdown both point at the version-pinned URL, with the correct alt text and version segment in the rendered SVG.

What this PR does NOT change:
- brand.json enrichment shape — Stage 5 adds the `badges[]` array.
- Badge issuance, JWT signing, SVG rendering, route handlers — all unchanged.

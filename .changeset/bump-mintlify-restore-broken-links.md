---
---

**Bump Mintlify 4.2.521 → 4.2.525, restore broken-links CI to its
intended posture, fix three real broken doc links it had been masking.**

Closes #2983.

Mintlify 4.2.525 ships with a deps-graph that no longer mixes React 18
and 19 across `@mintlify/*` subpackages. Local hook and CI both run
clean now — no `Invalid hook call` startup crash, and the MDX parser
no longer chokes on `.changeset/*.md` bodies — so the workarounds
landed earlier this week can come back out:

- `package.json` — `mintlify ^4.2.521` → `^4.2.525`. Lockfile updated.
- `.github/workflows/broken-links.yml` — replaced the React-crash
  tolerance grep filter and the `.changeset/` shuffle with a plain
  `npx --no-install mintlify broken-links`. The grep was a real
  hazard: it filtered out lines containing `react` (case-insensitive)
  before searching for failure patterns, which masked any genuine
  failure mentioning a React-related path. The first time Mintlify
  ran cleanly it surfaced **three real broken doc links** that had
  been hiding behind the workaround:
  - `docs/reference/url-canonicalization.mdx` linked
    `/schemas/adagents.json` and `/schemas/core/format-id.json` as
    bare paths; Mintlify treats those as internal page routes (which
    don't exist) rather than CDN passthroughs. Switched both to
    absolute `https://adcontextprotocol.org/schemas/v3/...` URLs
    matching the convention in `docs/intro.mdx` and other published
    docs.
  - `docs/trusted-match/specification.mdx` had the same bare
    `/schemas/adagents.json` link in the Seller Agent Attribution
    paragraph (landed in PR #2984). Same fix.
- `.husky/pre-push` — dropped `.changeset/` from the shuffle list.
  The other shuffles (`dist/addie/rules`, `.addie-repos`, `.context`)
  remain — those still hold non-MDX markdown that Mintlify shouldn't
  scan.

Verified locally: `npx mintlify broken-links` exits 0 with
"success no broken links found" against the cleaned repo.

Not protocol-related — descriptions-only doc fixes plus tooling
config — so this changeset is empty (no package version bump).

---
---

fix(server): canonicalize Addie's building/* URLs to post-IA-reorg paths (closes #4025)

The IA reorg in PRs #4017 / #4020 / #4022 / #4031 / #4032 / #4033 moved `/docs/building/` pages into a layered structure. Mintlify redirects make every old URL keep working, but Addie's source-of-truth URL knowledge still cited the old paths — meaning Addie handed users redirected URLs (a small but real UX degradation: 30x → canonical instead of canonical directly).

This was tracked under #4025 as a post-deploy follow-up — `check:owned-links` couldn't pass with the new paths until the redirect deploy was live on production. Verified deploy state before this PR with HEAD/GET probes against the five canonical destinations:

- `/docs/building/by-layer/L4/build-an-agent` — 200 ✓
- `/docs/building/verification/validate-your-agent` — 200 ✓
- `/docs/building/by-layer/L4/choose-your-sdk` — 200 ✓
- `/docs/building/concepts/adcp-vs-openrtb` — 200 ✓
- `/docs/building/operating/seller-integration` — 200 ✓

13 FQDN URLs updated across 5 files:
- `server/src/addie/rules/urls.md` (4 URLs)
- `server/src/addie/rules/knowledge.md` (3 URLs + 1 in the deprecated-platform note)
- `server/src/addie/rules/behaviors.md` (3 URLs)
- `server/src/addie/mcp/certification-tools.ts` (3 URL constants at lines 2260–2262)
- `server/src/addie/prompts.ts` (2 URLs at line 218 — seller-integration + schemas-and-sdks)

Mapping (matches the `redirects[]` map in `docs.json`):

| Old | New |
|---|---|
| `/docs/building/build-an-agent` | `/docs/building/by-layer/L4/build-an-agent` |
| `/docs/building/validate-your-agent` | `/docs/building/verification/validate-your-agent` |
| `/docs/building/schemas-and-sdks` | `/docs/building/by-layer/L4/choose-your-sdk` |
| `/docs/building/understanding/adcp-vs-openrtb` | `/docs/building/concepts/adcp-vs-openrtb` |
| `/docs/building/implementation/seller-integration` | `/docs/building/operating/seller-integration` |

Note: `schemas-and-sdks` was split in Phase 3 (PR #4031) into `by-layer/L0/schemas` (wire-layer reference) and `by-layer/L4/choose-your-sdk` (SDK list / coverage matrix / install commands / CLI tools). All Addie's pre-existing references were SDK-list shaped (talking about CLI tools, package exports, the `adcp` CLI), so they map to `choose-your-sdk` rather than `schemas`.

`npm run check:owned-links` passes locally (no follow-redirects needed; new paths return 200 directly).

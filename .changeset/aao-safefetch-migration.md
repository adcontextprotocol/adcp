---
---

Migrate AAO adagents.json + brand.json validators from `axios` to the
SSRF-defended `safeFetch` (issue #4129).

The publisher endpoint went unauthenticated-reachable in PR #4128, so the
4 axios sites in `adagents-manager.ts` (adagents fetch, authoritative
fetch, agent-card probe, MCP preflight) and the 1 site in
`brand-manager.ts` (brand.json fetch) were SSRF-able via auto-crawl.

`safeFetch` was extended to support POST with a body for the MCP
preflight, and a `safeFetchAxiosLike` adapter returns the
`{status, data, headers}` shape the call sites already expected — keeping
the migration mechanical and the SSRF guarantees uniform across all
outbound publisher-triggered fetches.

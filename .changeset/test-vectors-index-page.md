---
---

docs: add `/docs/reference/test-vectors/` index page cataloging the 8 reference vector sets that ship today, and fix three broken canonical-URL sites discovered while drafting it.

**New page** (`docs/reference/test-vectors/index.mdx`): catalogs `request-signing`, `webhook-signing`, `plan-hash` (compliance-tree, versioned) and `transport-error-mapping`, `mcp-response-extraction`, `a2a-response-extraction`, `webhook-payload-extraction`, `webhook-hmac-sha256` (transport fixtures, unversioned). Frames vectors as complements to storyboards without making a conformance claim, states honest versioning policy (compliance-tree sets frozen per GA at `/compliance/{version}/test-vectors/{set}/`; transport fixtures unversioned and SHOULD be vendored by SHA), enumerates the 8 public `kid`s currently published across the two signing sets with a "present or future, any kid in any `keys.json`" non-trust rule, and points `#2383` / 3.1 as the home for task-level fill-in. Wired into the sidebar under Reference.

**Bug fix — three broken canonical-URL sites** found by curling against the live CDN. The signing READMEs and one `security.mdx` link pointed at `https://adcontextprotocol.org/test-vectors/{request,webhook}-signing/` paths that return 404; the resolvable canonical is `/compliance/{version}/test-vectors/{set}/`, served by `server/src/schemas-middleware.ts` from `dist/compliance/` (built by `scripts/build-compliance.cjs` from `static/compliance/source/`). Fixed in:

- `docs/building/implementation/security.mdx:840` — `canonicalization.json` link
- `static/compliance/source/test-vectors/request-signing/README.md:7` — "Canonical URLs" paragraph
- `static/compliance/source/test-vectors/webhook-signing/README.md:7` — same

Any SDK, CI config, or cached doc that was consuming the old `/test-vectors/{request,webhook}-signing/…` path was already 404ing. No behavior change on URLs that actually resolved.

**Backlink** from `docs/building/conformance.mdx:130` so readers land on the new index when the conformance doc mentions reference vectors.

No spec/schema changes. No change to the compliance build. Deferred out of scope and noted in this PR's description: README structural parallelism (symmetric section headings across the two signing READMEs), a sibling machine-readable `index.json`, and a task-level vector corpus.

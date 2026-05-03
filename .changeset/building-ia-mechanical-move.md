---
---

docs(building): IA Phase 2 — relocate pages by layer, add redirects + nav

Phase 2 of the IA reorg in `specs/building-ia-by-layer.md` (merged in #4017, decision page in #4020). Mechanical relocation of `/docs/building/` pages into the layered structure the spec proposed.

**Page moves (~41 pages):**
- `build-an-agent`, `migrate-from-hand-rolled` → `by-layer/L4/`
- `implementation/{task-lifecycle,async-operations,webhooks,error-handling,comply-test-controller}` → `by-layer/L3/`
- `integration/{authentication,account-state,accounts-and-agents,context-sessions}` → `by-layer/L2/`
- `implementation/{security,webhook-verifier-tuning}` → `by-layer/L1/`
- `integration/{mcp-guide,a2a-guide,a2a-response-format}` + `implementation/{mcp,a2a}-response-extraction` → `by-layer/L0/`
- `understanding/*` (6 pages) → `concepts/*` (renamed group)
- `sdk-stack`, `version-adaptation`, `implementation/known-ambiguities` → `cross-cutting/`
- `operating-an-agent`, `implementation/{orchestrator-design,transport-errors,seller-integration,storyboard-troubleshooting}` → `operating/`
- `conformance`, `compliance-catalog`, `validate-your-agent`, `grading`, `get-test-ready`, `aao-verified` → `verification/`

**Deleted (per IA spec):**
- `where-to-start.mdx` — content absorbed into the new `building/index.mdx` decision page (Phase 1 / PR #4020)
- `integration/index.mdx`, `implementation/index.mdx` — replaced by per-layer landings

**New layer-landing `index.mdx` stubs** (`by-layer/L0/index`, `L1/index`, `L2/index`, `L3/index`, `L4/index`) — thin landing pages naming the layer's responsibility and listing the pages within it.

**`docs.json` nav rewritten** in both the `"3.0"` and `"latest"` version blocks (the `"2.5"` block references frozen `dist/docs/2.5.3/*` paths and was left untouched). New top-level structure: Concepts → Build by layer (L4/L3/L2/L1/L0) → Cross-cutting → Schemas → Verification & trust → Operating. Default-expand is on L4 only; all other layer groups default-collapse so the sidebar isn't a wall of links.

**43 redirects added** to `docs.json` `redirects[]` so every old URL keeps working transparently. Per-layer redirects + group renames + the three deleted landings.

**Internal cross-references** in all moved pages (44 files) rewritten mechanically to the new paths.

**External references** (the ~114 files outside `/docs/building/` that link in) intentionally NOT swept in this PR — Mintlify redirects make those work transparently. A separate hygiene PR can do the external sweep later if desired; not load-bearing.

**Out-of-tree updates:**
- `server/src/addie/rules/urls.md` — 3 building URLs updated to new paths so Addie's URL knowledge stays accurate.
- `scripts/build-protocol-tarball.cjs` — 1 URL in the protocol tarball README updated.

**Deferred to Phase 3:**
- Splitting `schemas-and-sdks.mdx` into `by-layer/L0/schemas` + `by-layer/L4/choose-your-sdk` (page split + content rewrite, separate PR).
- Creating the build-shaped `by-layer/L4/build-a-caller.mdx` (currently the index page CardGroup links to `/docs/protocol/calling-an-agent` as a placeholder).
- Verification-section placement (top-level vs nested) — deferred until the AAO Verified L3/L4 reframing lands per #3925 / #3046.

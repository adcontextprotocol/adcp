---
---

docs(building): IA Phase 3 — split schemas-and-sdks, add build-a-caller

Phase 3 of the IA reorg in `specs/building-ia-by-layer.md`. Two pages added, one split, internal cross-refs updated.

**New: `by-layer/L4/build-a-caller.mdx`** — the missing client-side L4 build guide. Build-shaped (install SDK, discover the agent, make a call, handle the three response shapes, recover from errors, receive webhooks, ingest reporting), distinct from the spec-level wire contract at `/docs/protocol/calling-an-agent`. Closes the placeholder Card on `building/index.mdx` that previously linked to the protocol reference.

**Split: `schemas-and-sdks.mdx` → two pages**
- **`by-layer/L0/schemas.mdx`** (new) — the wire-layer reference: schema access, the protocol tarball, Sigstore signature verification, compliance storyboards, common schemas, AI coding-agent guidance, schema versioning, bundled schemas, version discovery, registry API.
- **`by-layer/L4/choose-your-sdk.mdx`** (new) — the adopter decision: AdCP 3.0 support matrix, coverage matrix, JS/Python/Go install + sample code, package exports, CLI tools.
- **`schemas-and-sdks.mdx`** deleted — redirect added (`/docs/building/schemas-and-sdks` → `/docs/building/by-layer/L0/schemas`).

**Nav rewritten** (both 3.0 and latest blocks):
- L0 group: `index → schemas → mcp-guide → a2a-guide → ...`
- L4 group: `index → choose-your-sdk → build-an-agent → build-a-caller → migrate-from-hand-rolled`
- Cross-cutting group: `schemas-and-sdks` removed (replaced by the two split pages in L0/L4)

**Internal cross-references updated** in:
- `docs/building/index.mdx` — Build-a-caller Card now points at the new build-shaped page (no more placeholder note); Cross-cutting concerns split into Schemas + Choose your SDK bullets.
- `docs/building/cross-cutting/sdk-stack.mdx` — schema reference points at L0/schemas.
- `docs/building/by-layer/L0/mcp-guide.mdx` — `#cli-tools` anchor reference now points at choose-your-sdk.
- `docs/building/by-layer/L4/build-an-agent.mdx` — bottom-of-page resource list points at choose-your-sdk.
- `docs/building/verification/get-test-ready.mdx`, `docs/building/verification/validate-your-agent.mdx`, `docs/building/concepts/index.mdx` — references rerouted to the appropriate new page.
- `docs/protocol/calling-an-agent.mdx` — protocol-tarball link to schemas, added pointer to the new `build-a-caller` build guide in Related.

**Out-of-tree updates** (where redirects don't reach or paths matter):
- `server/public/llms.txt` and `llms-full.txt` — point to choose-your-sdk.
- `server/src/schemas-middleware.ts` — error-message URL points at the L0/schemas anchor for tarball verification.
- `server/src/addie/mcp/certification-tools.ts` — 3 template-literal URLs (filtered out of `check:owned-links` by the `${` filter) updated to canonical `/docs/building/by-layer/L4/choose-your-sdk`.

**FQDN URLs in `check:owned-links` scope intentionally left at old paths** (per the post-merge sweep policy in #4025):
- `server/src/addie/rules/urls.md`, `behaviors.md`, `knowledge.md` — still cite `https://docs.adcontextprotocol.org/docs/building/schemas-and-sdks`. Will 30x to canonical post-deploy via the redirect added in this PR. Cleanup will land with the post-merge sweep.
- `server/src/addie/mcp/certification-tools.ts:2262` — same.
- `server/src/addie/prompts.ts:218` — same.

**Phase 3 status:**
- ✅ Item 1 (split schemas-and-sdks) — done.
- ✅ Item 2 (build-a-caller) — done.
- ⏸ Item 3 (verification placement, top-level vs nested) — deferred per IA spec, awaiting AAO Verified L3/L4 reframing per #3925, #3046. Cross-link comments posted on both issues.

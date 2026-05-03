---
---

docs(building): rewrite /building overview as single decision page

Phase 1 of the IA reorg in `specs/building-ia-by-layer.md`. Rewrote `docs/building/index.mdx` from a section-overview-with-CardGroups page into a single decision page that opens with "where do you want to spend your engineering time?" and routes the reader to one of four entry points (build an agent, build a caller, migrate from hand-rolled, go lower than L4).

Absorbs content from `docs/building/where-to-start.mdx`:
- The five-layers-in-one-paragraph summary
- The "recommended path" framing (95% of adopters: start at L4)
- The three-questions decision flow (caller-vs-agent, what's-your-value-add, hand-rolled-already)

`where-to-start.mdx` left in place for this PR per the phasing plan; it'll be merged or redirected in a later PR. The two pages now overlap on content but the new index is the primary entry point from the section header.

Cross-cutting concerns (schemas, version adaptation, conformance, AAO Verified, operating) get their own section. "Going deeper" links into the existing Understanding / Foundations / Implementation subgroups so they remain discoverable until the layered reorg lands in PR2.

Caller-side gets a parallel Card to the agent-side build path (currently linking to `/docs/protocol/calling-an-agent` since the build-shaped `build-a-caller` page doesn't exist yet — that's a Phase 3 deliverable).

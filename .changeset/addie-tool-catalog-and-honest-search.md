---
---

Append an auto-generated authoritative tool catalog to Addie's system prompt and add a behavior rule against the "tools aren't loaded in this conversation" framing.

`scripts/build-addie-tool-reference.ts` now emits both `docs/aao/addie-tools.mdx` (public reference) and `server/src/addie/generated/tool-catalog.generated.ts` (compact catalog injected into Addie's prompt) from the same source — `server/src/addie/mcp/*-tools.ts` plus `tool-sets.ts`. The runtime catalog cannot drift from the public docs page because both are written together.

Pairs with a new rule in `server/src/addie/rules/behaviors.md` that requires Addie to report what she searched and what came back, rather than claiming a tool isn't loaded — the catalog is always in her prompt, so "not loaded" is never the honest framing.

---
---

docs(known-limitations): document the no-runtime-schema-tool decision (#3057 closed)

#3057 proposed a `get_schema` capability tool to expose request and response shapes for tasks on a live agent (sibling of `get_adcp_capabilities`). After expert review the decision is to NOT add it for 3.1.0:

- Coding agents (Claude Code, Cursor) discover shapes via the SKILL.md files we package with the spec. That covers the LLM-as-client path.
- SDK builders read schemas from the public `/schemas/v3/bundled/` URLs at build time. That covers the validation path adcp-client#909 was solving for.
- The only uniquely-runtime case is private tool extensions on a specific agent — rare enough in 3.x not to warrant a normative tool surface.

Adds a bullet under `## Conformance and testing` in `docs/reference/known-limitations.mdx` so adopters wondering about runtime schema discovery have a clear forward pointer to the decision and the conditions that would change it (non-Anthropic LLMs without skill loaders becoming primary consumers, or private tool extensions becoming common).

#3057 will be closed referencing this entry.

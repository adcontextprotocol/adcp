---
---

Add `docs/protocol/design-principles.mdx` (the meta-protocol — load-bearing
principles behind AdCP's design with explicit "what this rules out" and
"when you'd be right to push" clauses) and `docs/protocol/capabilities-explorer.mdx`
(browsable view of the get_adcp_capabilities response schema with per-node
"propose extension here" links pre-filled with the path). Surface
spec-guidelines.md in nav. Demonstrate the "why this shape" callout pattern
on `get_products` and `get_adcp_capabilities` task pages.

The principles page names the surface contradictions we know about
(`media_buy.execution.trusted_match` location, `axe_integrations` survival
in v3, three top-level "things this agent does" lists, three signing-related
top-level keys, the trust substrate gap to 4.0) — the principles are
credible only to the extent we're honest about where the surface still
violates them.

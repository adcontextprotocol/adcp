---
---
Refine ads.txt managerdomain compatibility fallback semantics:

- support only explicit `MANAGERDOMAIN=` directive lines (case-insensitive key)
- ignore comment-only `# managerdomain=...` lines
- when multiple eligible directives are present, use the **last** eligible entry in file order
- keep one-hop/cycle/noagents safety behavior
- align docs in `docs/governance/property/adagents.mdx` with managed-network guidance and these fallback semantics

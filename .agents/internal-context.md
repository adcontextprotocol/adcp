# Internal Context (not injected into Addie)

Strategic framing, editorial narratives, gaps, and maintainer-only
commentary about the AdCP ecosystem. Triage routines read this file for
richer relevance decisions but **never quote from it in public comments**.
Addie does **not** read this file — keep it free of content you'd want
her to answer with.

Content that belongs here vs. `current-context.md`:

| Here (internal) | There (public `current-context.md`) |
|---|---|
| "X is a tier-1 gap" | "X is active. PR #Y." |
| "blocked on Brian's call" | "blocked. Status: deferred." |
| "stakeholder flagged" | "see PR #Z" |
| Editorial framing, strategic bets | Factual status + link |
| Narratives | Facts |

Refreshed weekly by the context-refresh routine alongside
`current-context.md`.

Last refresh: 2026-04-23 (initial seed)

## Narratives and gaps

- **Security narrative gap** — mechanics exist (security.mdx,
  idempotency, auth declarations) but no community-facing narrative or
  curriculum. Brian flagged as tier-1 gap 2026-04-19. Status: **active**.
- **SDK both-sides framing** — @adcp/client and adcp (Python) ship
  server primitives + testing utilities. Docs framing reads
  caller-first, hides this. Status: **active**.

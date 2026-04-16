---
---

Fix 404s on `/schemas/v{N}/<file>` alias paths (e.g. `/schemas/v3/adagents.json`).

The alias-rewrite middleware was registered after the `/schemas` static handler,
so alias paths fell through to a 404 even when the version existed. Consolidate
alias resolution, bare-directory redirects, and static serving into a single
ordered middleware (`mountSchemasRoutes`), fix the directory-redirect to include
the `/schemas` prefix, and teach the redirect regex to match prerelease versions
(e.g. `3.0.0-rc.3/`). Adds HTTP-level integration tests that exercise the real
middleware against `dist/schemas/`.

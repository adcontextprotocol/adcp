---
---

Add canonical URL reference to Addie KB (`server/src/addie/rules/urls.md`) — a single source of truth for all owned-domain URLs Addie is permitted to cite. Closes #2564.

- New `urls.md` rule file lists all live agenticadvertising.org and docs.adcontextprotocol.org URLs with descriptions; includes a Deprecated section for retired URLs.
- `rules/index.ts`: add `urls.md` to `RULE_FILES_BEFORE_CONTEXT` so Addie's context includes the reference on every request.
- CI broken-link checker already scans `server/src/addie/rules/*.md`, so every URL in the new file is validated on every PR with no script changes required.

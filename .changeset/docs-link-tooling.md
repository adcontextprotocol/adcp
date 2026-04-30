---
---

Docs link tooling: pre-push hook fix, schema-link autofix, dev wrapper.

- `.husky/pre-push`: fold `dist/docs` into the existing MOVED loop and drop the silent `git checkout` restore so a failed Mintlify run can't sweep mass deletions into the next `git add -A`. Closes #3633.
- `scripts/remark-schema-links/`: env-aware plugin + tests rewriting bare `/schemas/...` paths and post-autofix absolute prod URLs based on mode (prod / preview / dev).
- `scripts/lint-schema-links.mjs` + `npm run lint:schema-links` / `fix:schema-links`: autofix bare `/schemas/...` links in committed source to absolute prod URLs. Wired into pre-push and the broken-links CI workflow. Closes #3634.
- `scripts/dev-docs.mjs` + `npm run dev:docs`: wraps `mintlify dev` against a `.mintlify-dev/` staging dir; rewrites `/schemas/...` and absolute prod URLs to `localhost:3000/schemas/latest/...` so in-flight schema work previews against the local schema host. Hot-reloads via chokidar. Closes #3653.

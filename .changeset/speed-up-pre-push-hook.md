---
---

chore(hooks): speed up pre-push by path-gating Mintlify check and using the local devDep

The pre-push hook ran `npx --yes mintlify@4.2.500 broken-links` and `... a11y` on every push. `npx --yes` ignored the local `mintlify` devDependency and re-resolved a pinned version each time, adding tens of seconds to every push. The a11y check was warn-only and had no CI equivalent, so it burned time without gating anything.

Now the hook:
- only runs broken-links when files under `docs/`, `mintlify-docs/`, `server/src/addie/rules/`, etc. actually changed on the branch;
- uses `npx --no-install mintlify` so it resolves from the local devDep;
- drops the a11y check (CI `.github/workflows/broken-links.yml` is the authoritative gate);
- only shuffles sibling dirs in/out of `/tmp` when Mintlify actually runs.

Non-docs pushes now finish in ~1s of hook time.

---
---

Two release-pipeline hardening fixes for 3.0.4 and beyond:

**`.dockerignore` un-excludes `dist/compliance`**: previously `/compliance/{version}/` URLs returned 404 because the Docker build context excluded `dist/` with only `!dist/schemas` and `!dist/protocol` re-includes. Versioned compliance bundles never made it into the Fly image even though they were committed to the repo. SDK consumers fetching `compliance/cache/3.0.X/` URLs hit fresh-cache 404s. Adds `!dist/compliance` (with `dist/compliance/latest` re-excluded since it's regenerated in-container).

**Forward-merge workflow auto-resolves divergent metadata**: the `forward-merge-3.0.yml` workflow's bare `git merge` failed every time on the same predictable conflicts (`package.json` version field bumped on each line, `.changeset/*.md` consumed differently, etc.) — manual resolution every release. Now the workflow:

- Drops the brittle `git merge-base --is-ancestor` shortcut (returns false after squash-merges even when content is in main)
- Attempts the merge; auto-resolves conflicts on an explicit allowlist:
  - `package.json` / `package-lock.json` → take 3.0.x's (version propagates)
  - `.changeset/*.md` / `.changeset/pre.json` → preserve main's (main consumes changesets on its own beta schedule)
  - `static/schemas/source/index.json`, `static/schemas/source/registry/index.yaml`, `CHANGELOG.md`, `dist/*` → take 3.0.x's
- Fails loud on any conflict outside that allowlist (indicates a playbook violation — a change on 3.0.x that wasn't first cherry-picked from main)
- Post-merge `git diff --quiet origin/main HEAD` skip — if 3.0.x's content is already on main (e.g. via a prior squash-merge), the workflow exits cleanly without opening a PR

Companion update to `.agents/playbook.md` § Release lines documenting the auto-resolution behavior. PR review checklist updated to spot main-unique `package.json` content that may have been overwritten (a missed cherry-pick).

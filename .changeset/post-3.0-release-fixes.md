---
---

Post-3.0 GA release fixes to make the next cut work end-to-end without manual intervention:

- `changeset tag` now runs on private packages (`privatePackages.tag: true`), so future Version Packages merges auto-tag and `changesets/action` auto-creates the GitHub Release with artifacts
- `.dockerignore` keeps `dist/protocol/` so cosign-signed versioned tarballs ship in the Fly.io image and `/protocol/{version}.tgz` actually serves
- Two flaky tests in `adagents-manager.test.ts` get a 10s timeout (matches their sibling at line 410). The underlying issue — `@adcp/client` makes real network calls from inside a "unit" test — should be fixed by mocking `@adcp/client` at the test file level
- Drop the duplicate autogen `## 3.0.0` section from `CHANGELOG.md` (the curated narrative at the kept block is enough)
- Add `.agents/shortcuts/cut-major.md` runbook covering the full cut-a-major process with the gotchas we hit on 3.0: audit non-protocol changesets, don't hand-edit `CHANGELOG.md` on the release branch, verify `/protocol/{version}.tgz` serves end-to-end

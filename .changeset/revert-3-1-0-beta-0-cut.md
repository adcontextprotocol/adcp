---
---

Revert the premature `3.1.0-beta.0` Version Packages cut (#3436) that was merged before we were ready AND whose `release.yml` post-merge run was cancelled by concurrency, leaving `package.json`/`dist/` referencing a phantom version that was never tagged or published.

Restores `package.json` to `3.0.1`, drops the `## 3.1.0-beta.0` CHANGELOG block, removes never-published `dist/{schemas,compliance}/3.1.0-beta.0/` and `dist/protocol/3.1.0-beta.0.*` artifacts, and re-stores the 28 consumed `.changeset/*.md` files so they aggregate cleanly into a future cut. Pre mode stays active. The schema/feature work that landed via 3.1-eligible PRs (#3015, #2994, #3427, etc.) is unaffected — only the version bump and CHANGELOG entries are rolled back.

Companion to the `3.0.x` force-reset to `v3.0.1^{commit}` (backup tag `archive/3.0.x-pre-cleanup-2026-04-30`) and the deletion of the bad `v3.0.2-beta.0` tag/release. Underlying GITHUB_TOKEN recursion bug tracked in #3417.

---
---

Auto-attach `dist/protocol/${VERSION}.tgz` (plus `.sha256`, `.sig`, `.crt` sidecars) to the GitHub Release that `changesets/action` creates. `createGithubReleases: true` only writes the changelog body; files were never uploaded automatically.

v3.0.0's assets were uploaded by hand on 2026-04-22; v3.0.1 / v3.0.2 / v3.0.3 all shipped with empty asset lists despite the tarballs being committed to `dist/protocol/` by the release pipeline. Adopters who pin via the release URL (`gh release download v3.0.3 -p '*.tgz'`) hit 404. New step uploads them via `gh release upload --clobber` gated on `steps.changesets.outputs.published == 'true'` so it only fires on actual tag-and-release runs, not Version Packages PR-creation runs.

Companion backfill (manual `gh release upload` for v3.0.1 / v3.0.2 / v3.0.3 from the existing `dist/protocol/` tree) handled separately.

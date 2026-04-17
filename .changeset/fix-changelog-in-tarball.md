---
---

fix: include CHANGELOG.md in deployed protocol tarball

`.dockerignore` was stripping all `*.md` except `README.md`, so the builder stage had no `CHANGELOG.md` on disk when `build:protocol-tarball` ran, and deployed tarballs shipped with `manifest.changelog: false`. Added `!CHANGELOG.md` exception. Takes effect on next deploy.

---
---

Fix hosted compliance target resolution for stable 3.0 agents while 3.1 beta caches are present.

Hosted compliance now resolves default runs to the latest stable 3.0 bundle, supports explicit `3.0`, `3.1-beta`, and exact bundled targets, persists the requested/resolved target pair, and keeps explicit non-default Addie targets diagnostic-only. No package release is required; this is server-side compliance orchestration.

---
"adcontextprotocol": patch
---

Build pipeline: prevent PR #4769-class outages where a runtime asset added to `server/src/**` is missing from the shipping image because the Dockerfile copied it by exact filename. `npm run build` now mirrors every allowlisted non-TypeScript file (`.json`, `.md`, `.sql`, `.txt`, `.csv`, `.yaml`/`.yml`, `.html`, `.xml`) from `server/src/**` into `dist/**` automatically (`scripts/copy-server-assets.cjs`); the Dockerfile drops three redundant per-directory `COPY` lines; and a new CI check (`scripts/copy-server-assets.cjs --check`) fails the build if `dist/` ever diverges from source. No protocol surface change.

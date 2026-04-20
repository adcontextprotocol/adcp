---
---

Point docs schema links at `/schemas/latest/` instead of `/schemas/v3/` so the `latest` docs channel links to the live development schemas (where newly added fields like `reporting_delivery_methods` actually live) rather than the last-cut RC.

`/schemas/v3/` resolves to the highest released 3.x version (currently `3.0.0-rc.3`) and is immutable relative to that cut. Live docs describe the moving target, so they now link to `/schemas/latest/`. `scripts/rewrite-dist-links.sh` rewrites `/schemas/latest/` → `/schemas/$VERSION/` when building frozen docs snapshots under `dist/docs/$VERSION/`, so released docs still pin to their own schema version.

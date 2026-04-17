---
---

Force revalidation on `/schemas/latest/` and version aliases (`/v2`, `/v2.5`, `/v3`, etc.) by serving `Cache-Control: public, no-cache, must-revalidate` instead of the 10-minute default. Pinned semver paths (`/3.0.0-rc.3/...`) remain `immutable`. Prevents edge caches from serving different versions from different POPs while an alias retargets, which caused CI drift for consumers generating types from the schemas.

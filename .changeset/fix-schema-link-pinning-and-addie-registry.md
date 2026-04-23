---
---

Pin all `docs/` schema links from `/schemas/latest/` to `/schemas/v3/` so the current stable docs stay aligned with v3 schemas after v4 development begins. Addie's schema tools now fetch the live `index.json` registry instead of a stale hardcoded list — fuzzy match and error messages cover every schema the spec ships, so guesses like `core/get-capabilities-response.json` resolve to `protocol/get-adcp-capabilities-response.json` instead of 404ing. Dist-docs rewriter also pins major-version aliases to the exact release version on snapshot, and `check-schema-links.yml` now flags any new `/schemas/latest/` references in `docs/`.

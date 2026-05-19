---
---

revert: #4771 OpenAPI manual entries

`static/openapi/registry.yaml` is regenerated from Zod schemas in `scripts/generate-openapi.ts`. Hand-written paths added in #4771 get wiped by the regenerator, and every PR has been failing the `test:openapi` freshness check since #4771 landed. Reopening #4749 to redo the brand-registry docs via `registry.registerPath()` calls.

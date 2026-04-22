---
---

ci: fold schema-validation into build-check, narrow migration-smoke-test build

- `schema-validation.yml` deleted; its steps (`test:schemas`, `test:json-schema`, `test:extension-schemas`, `test:composed`, `check:registry`, `test:platform-agnostic`, hmac conformance) move into `build-check.yml`. Schema tests read from `static/schemas/source` and don't depend on build output, so running them in the same job shares one `npm ci` + one checkout instead of spinning a parallel workflow. Build-check's branches extend to `[main, develop, '2.6.x']` to preserve the coverage schema-validation had.
- `migration-smoke-test.yml` replaces `npm run build` with `npx tsc --project server/tsconfig.json`. The job's goal is to run `dist/db/migrate.js` against a real Postgres; it doesn't need the schema, compliance, or protocol-tarball build steps. Verified locally: tsc alone produces `dist/db/migrate.js`, `dist/db/client.js`, and `dist/config.js` — the only files migrate.js touches.

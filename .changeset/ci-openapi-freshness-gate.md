---
---

CI: wire `npm run test:openapi` into `.github/workflows/build-check.yml` so the OpenAPI freshness gate fails its own PR instead of letting drift accumulate. The script (`tsx scripts/generate-openapi.ts && git diff --exit-code static/openapi/registry.yaml`) already existed in `package.json` and ran inside the umbrella `npm run test`, but `build-check.yml` cherry-picks specific test scripts and never invoked it. Result: Zod-schema PRs were landing without regenerating `static/openapi/registry.yaml`, and drift would only get swept up opportunistically (e.g. #4515 absorbed ~340 lines). No source schemas change — this is workflow-only. Closes #4516.

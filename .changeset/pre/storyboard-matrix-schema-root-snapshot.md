---
"adcontextprotocol": patch
---

`scripts/run-storyboards-matrix.sh` snapshots the freshly built `dist/schemas/latest` into a temporary directory and runs every tenant against that copy, so a concurrent `npm run build:schemas` in the same tree can no longer abort a tenant with the SDK's schema-root version mismatch. The pre-push hook treats the local matrix as advisory: it is skipped when the working tree has uncommitted changes or when `ADCP_SKIP_STORYBOARD_MATRIX=1`, with the `training-agent-storyboards.yml` workflow as the authoritative gate.

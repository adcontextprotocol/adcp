---
---

ci(storyboards): per-tenant probe_task override unblocks security_baseline on /signals

`security_baseline.assert_mechanism` was failing on /signals because the shared `acme-outdoor.yaml` test-kit declares `auth.probe_task: list_creatives` — a tool /signals doesn't serve. Sending `list_creatives` to /signals returned "method not found" before the auth layer ran, and the runner reported "no auth mechanism verified."

Override `auth.probe_task` per tenant when `TENANT_PATH` is set:

```ts
const PROBE_TASK_BY_TENANT: Record<string, string> = {
  signals: 'get_signals',
};
```

`get_signals` is on the SDK runner's allowlist of probe-safe tasks (auth-required, read-only, accept empty body) and is served by /signals. Other tenants keep the default `list_creatives`:
- /sales, /creative, /creative-builder serve `list_creatives` directly — default works.
- /governance and /brand don't serve any allowlisted tool, so `security_baseline` continues to fail there. The matrix floor absorbs this until either the runner's allowlist widens or the tenants gain an allowlisted tool.

Floor lift on /signals:

| Tenant   | Old | New | Delta |
|----------|-----|-----|-------|
| /signals | 66 / 54 | 67 / 58 | +1 / +4 |

Files: `server/tests/manual/run-storyboards.ts`, `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.

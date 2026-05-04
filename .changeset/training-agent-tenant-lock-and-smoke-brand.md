---
---

fix(training-agent): two follow-ups from the conformance Socket Mode stack work — (1) per-tenant async lock around the tenant router's `connect/handleRequest/close` window so back-to-back HTTP MCP requests no longer race the shared MCP `Server` instance and surface intermittent "Already connected to a transport" 500s (closes adcp#4084); (2) `--brand` flag on `server/tests/manual/storyboard-smoke.ts` so storyboards that reference a `test_kit` (e.g. media_buy_state_machine → acme-outdoor) can be run with the kit's brand domain and avoid the SDK runner's positive-path/negative-path brand split (closes adcp#4083 as not-a-training-agent-bug; the bug is in the upstream SDK runner's enricher fallback).

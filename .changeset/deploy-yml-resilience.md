---
"adcontextprotocol": patch
---

deploy.yml resilience: when `flyctl deploy` exits non-zero, probe `https://adcontextprotocol.org/health` before failing. If the app responds 200, treat the deploy as fallback-success (Fly machines API issue, not an app issue), skip Fly-API-dependent gates, and continue. Real app failures still hard-fail. Always capture `flyctl status` / `machines list` / `releases` / `logs` as a workflow artifact on failure for next-turn forensics. Closes #4780.

---
---

chore(server): bump @adcp/client 5.18.0 → 5.19.0 and probe idempotency backend at boot

Wires the new `IdempotencyStore.probe()` (5.19.0) into the main HTTP boot path right after `runMigrations()`. A misconfigured pool — typo in `DATABASE_URL`, missing migration, deprovisioned DB, wrong credentials — now fails the process at deploy time with a descriptive error naming the table and remediation, rather than silently passing every mutating call to a broken backend until the first 5xx in production.

`probe?.()` is optional on the store interface — when the lazy backend selection in `training-agent/idempotency.ts` falls back to `memoryBackend` (no DB initialized), the call is a no-op and boot proceeds normally.

5.19.0 also ships:
- `AgentClient.fromMCPClient()` — in-process MCP transport for compliance fleets (adcp-client#1008)
- Storyboard runner: `$generate:opaque_id` + `context_outputs[generate]` for runner-minted task IDs threaded through multi-step lifecycle storyboards (adcp-client#1006)
- `get_media_buys` extractor guard for mid-walk pagination pages (adcp-client#999)

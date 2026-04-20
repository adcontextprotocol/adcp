---
---

Training agent: infrastructure prep for the `createAdcpServer` framework migration.

- Export `getWebhookSigningKey()` from `server/src/training-agent/webhooks.ts`
  so the future framework config can pass the same key into
  `createAdcpServer({ webhooks: { signerKey } })`.
- Add `FRAMEWORK_MIGRATION.md` documenting the 10 blockers surfaced during
  a first-pass attempt (response shape vs framework `wrap`, McpServer
  CJS/ESM dual-resolution, VERSION_UNSUPPORTED / dry_run / stateless-HTTP
  task-store edge cases, 30+ custom tools outside `AdcpToolMap`, test
  harness `_requestHandlers` path) and the staged 4-PR plan to unwind
  them.

No runtime behavior change. The framework migration proper (replacing the
3,300-line hand-rolled dispatch in `task-handlers.ts`) will land in a
follow-up PR with dedicated type-system work budget.

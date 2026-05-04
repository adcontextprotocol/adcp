---
---

fix(training-agent): wire PostgresStateStore so tenant init stops fast-rejecting in production

Root cause confirmed via the diagnostic logging from #4067: every fresh
Fly machine logs `createAdcpServer: in-memory state store refused
outside {NODE_ENV=test, NODE_ENV=development}` for all six tenants
within ~13ms of boot. SDK 6.0.1 hard-refuses the module-singleton
`InMemoryStateStore` for multi-tenant deployments — and we never wired
a non-default store, so every `register()` throws and the registry
stays uninitialized indefinitely.

Adds `pickStateStore()` mirroring the existing `pickTaskRegistry()`
policy: `PostgresStateStore` in production, `InMemoryStateStore`
elsewhere. Re-throws on prod-pool init failure rather than falling back
(falling back would just re-trip the same SDK guard with extra confusion).

Migration `466_adcp_state.sql` — verbatim from the SDK's
`ADCP_STATE_MIGRATION` constant. Idempotent
(`CREATE TABLE IF NOT EXISTS`); runs once via `release_command` before
machine rolls.

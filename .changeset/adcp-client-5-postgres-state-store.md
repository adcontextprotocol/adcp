---
---

Bump @adcp/client 4.30.1 → 5.0.0 and back training-agent session state with the SDK's `PostgresStateStore`.

**Why**: the training agent's in-memory session Map didn't survive across the 2 Fly.io machines, so a buyer creating a property list (or media buy, or collection list) on one machine couldn't retrieve it on the other. Half the storyboards failed on that alone. The 5.0 SDK ships `AdcpStateStore` / `InMemoryStateStore` / `PostgresStateStore` specifically for this.

**What changed**:

- Training-agent `state.ts` rewritten: `getSession(key)` is now async and loads from `adcp_state` (JSONB per session key). A per-request `AsyncLocalStorage` cache lets multiple handler calls share the same `SessionState` object. `flushDirtySessions()` at end of request persists only sessions whose serialized shape actually changed.
- Dispatcher wraps handler execution in `runWithSessionContext`, flushes on clean return (not in `finally`, so thrown exceptions don't persist half-mutated state).
- All 48 tool handlers became `async` and added `await getSession(...)`. Logic unchanged.
- `getAllSessions()` cross-session fallback removed — it was a no-op across brands after the refactor and masked legitimate `MEDIA_BUY_NOT_FOUND` cases. Storyboards correctly scope per brand.
- `sessionKeyFromArgs` validates/caps `brand.domain` (253 chars, RFC-1035 charset) and `account_id` (128 chars, alphanumeric + `._-`) before they become Postgres primary-key values — prevents unbounded growth of `adcp_state`.
- `deserializeSession` filters `__proto__` / `constructor` / `prototype` map keys.
- `lastGetProductsContext.products` dropped from persistence (deterministic from the catalog); `proposals` still persist for the proposal lifecycle.
- Migration `397_adcp_state_store.sql` added.
- `member-tools.ts` simplified 4 `TaskResultFailure` error-handling sites for 5.0's discriminated-union `TaskResult` shape.
- Cross-machine persistence test added exercising serverA→serverB via the store.

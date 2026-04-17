---
---

Training agent adopts `@adcp/client` 5.1 state-store helpers:

- `serializeSession` / `deserializeSession` replaced by the SDK's `structuredSerialize` / `structuredDeserialize` (tagged `__adcpType` envelopes for Map/Date). Net: ~40 lines of hand-rolled type coercion removed; disk format is now the SDK canonical form.
- Per-flush 5 MB size check removed. `PostgresStateStore`/`InMemoryStateStore` enforce `DEFAULT_MAX_DOCUMENT_BYTES` at `put()` time and throw `StateError('PAYLOAD_TOO_LARGE')` automatically.
- Prototype-pollution `RESERVED_KEYS` filter removed. `structuredDeserialize` operates on tagged envelopes, and SDK key validation protects the store boundary.

Migration 411 clears `training_sessions` rows on deploy to avoid a format mismatch between pre- and post-change serialization. Training sessions have a 1-hour TTL and are sandbox state — losing them is equivalent to a machine restart. Other collections in `adcp_state` are unaffected.

Closes #2269.

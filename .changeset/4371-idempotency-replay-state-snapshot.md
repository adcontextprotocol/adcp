---
"adcontextprotocol": minor
---

spec(security): clarify idempotency-replay semantics for state-tracking fields on stateful resources.

The existing idempotency contract (security.mdx §Idempotency rule 2) made the immutable-cache invariant explicit for async (`submitted`) responses — even if the underlying task transitions to a terminal state, replay returns the originally-cached `submitted` payload, not the current state — but was silent on synchronous-success responses that carry state-tracking fields inline (`status` on `create_media_buy`, per-record arrays on `sync_*`, resource snapshots on `acquire_rights` / `activate_signal`). The gap surfaced in real storyboard runs: a media buy created with `status: pending_creatives`, then mutated to `canceled`, then replayed via the same `idempotency_key` returned the cached `pending_creatives` bytes. A buyer that trusted the response as current state hit `NOT_CANCELLABLE` on the next mutation and a state-machine bug. Three options surfaced:

1. **Replay returns cached bytes verbatim** — what sellers do today; preserves byte-stable replay; buyers must re-read for current state.
2. **Replay returns current state** — what buyers reading the bytes expected; breaks byte-stable replay and forces sellers to refresh the cache on every resource mutation.
3. **Capability-declared** — sellers advertise their replay policy.

Picked (1) and made it normative across both branches:

- Seller rule 2 extended explicitly to synchronous-success responses. State-tracking fields in the cached payload MUST NOT refresh on replay. Partial refresh ("some fields current, others snapshot") is non-conformant — it would multiply the number of valid cache contents for a given key and break the canonical-replay invariant the rest of the rules build on.
- New buyer-obligation paragraph: **Replay responses are historical snapshots.** Buyers requiring current state MUST consult the resource's read endpoint (`get_media_buys`, `list_accounts`, `list_creatives`, etc.). `replayed: true` is the explicit signal that a fresh read is required before any state-dependent decision. Agentic buyers MUST treat `replayed: true` as a stop signal for any planning step whose next action depends on resource state.
- `Response-level replay indicator` gains a `State-machine routing` bullet pointing back at the seller rule and buyer obligation so the contract reads consistently from either entry point.

Why (1) over (2) or (3): (2) forces every seller to thread the resource state machine through the idempotency cache (multiplying valid cache contents and breaking byte-stable replay). (3) adds capability surface for a question the spec should answer uniformly — heterogeneous replay semantics across sellers is exactly the kind of cross-seller inconsistency the idempotency contract exists to prevent. (1) is what existing sellers do; the gap was the contract being silent on sync-success, not divergent behavior.

Files:
- `docs/building/by-layer/L1/security.mdx` — seller rule 2 expanded (async + synchronous-success branches); new "Replay responses are historical snapshots" paragraph under "Buyer obligations"; `Response-level replay indicator` list gains the state-machine-routing bullet.

Closes #4371.

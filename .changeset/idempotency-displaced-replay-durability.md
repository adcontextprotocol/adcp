---
---

spec(idempotency): close displaced-replay window by requiring durable cache

The signature-nonce replay cache (~360 s window) and the
`idempotency_key` dedup cache (≥ 1h declared, 24h recommended for
requests; ≥ 24h declared for webhooks) are two different caches with
two different TTLs. The prior wording allowed the `idempotency_key`
cache to be an in-memory LRU that "MAY return a success path" when it
can't distinguish "never seen" from "evicted after process restart."
That tolerance opens a **displaced-replay window**:

1. Sender signs event E with `idempotency_key=K` and nonce N1 at T=0.
2. Receiver processes, caches response under K, caches N1 in nonce
   store. Side effect runs.
3. Receiver pod restarts / evicts / fails over; in-memory K cache is
   dropped. Signature nonce cache may or may not survive (typically
   also dropped, but irrelevant here).
4. Sender retries E at T=7 min with a fresh signature (nonce N2, same
   `idempotency_key=K`). A fresh-nonce re-send is how signed retries
   are supposed to work — nonces are per-send, not per-event.
5. Receiver passes signature verification (N2 fresh), app-layer dedup
   finds nothing under K, side effect runs again. Within the declared
   TTL. No attacker required — just a normal pod restart.

This is not a replay *attack* — it's a protocol-induced double-exec
under honest sender behaviour. The signed-retry model specifically
designs for this to be safe: the whole point of the `idempotency_key`
contract is that the receiver has absorbed the at-most-once burden.
An in-memory cache with a 24h declared TTL silently breaks that
contract every time a pod restarts.

Tightens two rules:

- `security.mdx` idempotency rule 6: durability is normative. Sellers
  MUST back the cache with storage that survives restarts for the
  declared `replay_ttl_seconds`. In-memory-only is non-conformant
  whenever declared TTL exceeds process lifetime (always true at the
  3600 s floor). Fail-closed (`IDEMPOTENCY_EXPIRED`), never fail-open
  (silent re-execution), on "can't tell never-seen from evicted."
  Operators whose reality is memory-only MUST declare a TTL no higher
  than guaranteed pod lifetime — which in practice forces a durable
  tier.

- `webhooks.mdx` dedup: SHOULD → MUST persist 24h in durable storage.
  Receivers whose tier cannot honor 24h MUST document the shorter
  window to every sender, not silently shorten.

No schema change — the semantic contract was already implied by
`replay_ttl_seconds` being declared. This closes the loophole where a
seller could declare 86400 s while running a 5-minute in-memory cache.

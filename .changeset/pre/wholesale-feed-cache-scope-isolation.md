---
"adcontextprotocol": minor
---

signals + media-buy: enforce cache-scope isolation for wholesale-feed conditional fetch

The schemas already state the wholesale-feed token is keyed by `(cache_scope, wholesale_feed_version)`, but nothing exercised that a token minted under one `cache_scope` cannot short-circuit (`unchanged: true`) a request the agent resolves to another. The reference training agent advertises `wholesale_feed_versioning.cache_scope_account: true` yet keys conditional fetch on a scope-independent token, so it would silently answer `unchanged` across scopes — exactly the gap reported in #5739.

- **Schemas** — `signals/get-signals-response.json` and `media-buy/get-products-response.json`: add a normative cross-scope MUST-NOT to the `unchanged` description, scoped to the conditional-fetch comparator (it MUST key on `(cache_scope, wholesale_feed_version)`, not the token alone).
- **Storyboards** — new universal `wholesale-feed-signals-scope-isolation` and `wholesale-feed-products-scope-isolation`, gated on `wholesale_feed_versioning.cache_scope_account: true`; agents without per-account overlays grade `not_applicable`.
- **Reference agent** — scope-key the wholesale feed/pricing tokens so the comparator rejects cross-scope tokens (and the existing same-scope `unchanged` path still matches).

Closes #5739.

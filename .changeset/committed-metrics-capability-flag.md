---
"adcontextprotocol": minor
---

Add `committed_metrics_supported` capability flag to
`media-buy-features.json`. Closes the buyer-side detection gap from
#3510 where absence of `committed_metrics` was indistinguishable
between 'seller didn't snapshot' and 'seller doesn't have snapshot
infrastructure.' Closes #3517.

**Why one flag (not two).** Per the unified metric-accountability
design (#3576), `committed_metrics` is a single array carrying both
standard and vendor-defined entries. The flag inherits that unification —
one flag declares the seller's snapshot capability across the whole
contract surface.

**MUST timing — atomic.** Sellers declaring this flag `true` MUST
populate `committed_metrics` on every `create_media_buy` response AND
MUST honor append-only mid-flight metric additions via `update_media_buy`.
The MUST ships with the flag, not as a future tightening — advisory-only
flags leave the audit gap exploitable, defeating the purpose.

**Placement choice — Option A (extend `media-buy-features.json`).**
Matches the existing `property_list_filtering` / `catalog_management`
precedent. Buyers can pass it as a `required_features` filter on
`get_products` to narrow the catalog to snapshot-supporting sellers —
that side effect is the design intent, not a bug.

**Backwards compatibility.** Optional and additive. Sellers without
the flag are unchanged; buyers ignore the flag if they don't filter on
snapshot support.

Closes #3517.

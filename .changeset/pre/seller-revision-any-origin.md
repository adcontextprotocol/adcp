---
"adcontextprotocol": minor
---

Seller revisions advance on every committed change, whatever its origin (#8142). For every resource that carries a seller-maintained revision, the seller MUST advance it on every committed change to state that resource's authoritative read reports: an AdCP task, a seller operator, seller automation, another authorized principal, or a connected platform. An externally observed change advances it when the seller ingests it, within the source's declared freshness bound. Reads, validation-only calls and exact idempotency replays do not advance it. This tightens the media-buy `revision` rule, so buyers that update without re-reading will see more `CONFLICT`; it is listed in the 3.3 exceptions table in `versioning.mdx`.

- Both carve-outs are removed. Assignment changes made through `sync_creatives` now advance the media-buy `revision`, once per affected buy in the same atomic write. The seller-optimized allocation text is restated: changes to values the buy reports (caps, targets, pacing, lifecycle state) advance the revision and append a `seller_system` history entry, and spreading spend between packages inside the accepted caps stays delivery behavior because no read reports it. For allocation this is a clarification, not a new tightening.
- `get_media_buys` `history` entries gain an optional `origin`, a `$ref` to `account.change.origin`, with the same `kind` vocabulary (`adcp`, `seller_operator`, `seller_system`, `connected_platform`, `unknown`). It is required on entries for changes that did not arrive through an AdCP task. `actor` is unchanged.
- `list_creatives` creatives gain an optional seller-maintained, monotonic, opaque `seller_revision` (integer or string), distinct from the buyer-assigned `revision_id`, with a new `creative_seller_revision` `x-entity` value.
- `account.change.resource_revision` carries the family's seller revision when one is defined: `revision` for a media buy or account, `seller_revision` for a creative.

Seller revisions for packages, creative assignments, audiences, catalogs, event sources, property lists, products and signals are deferred to 3.4, one change per family.

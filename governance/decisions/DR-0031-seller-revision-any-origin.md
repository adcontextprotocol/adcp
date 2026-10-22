---
id: DR-0031
title: Seller revisions advance on every committed change, whatever its origin
class: normative
status: accepted
date: 2026-10-19
refs: ["#8142", "#8159", "#6810"]
dissent: none
---

## Decision

For every resource that carries a seller-maintained revision (the media-buy `revision`, the account `revision` and the creative `seller_revision`), the seller MUST advance it on every committed change to state that resource's authoritative read reports, whatever the origin: an AdCP task, a seller operator, seller automation, another authorized principal, or a connected platform. An externally observed change advances it when ingested, within the source's declared freshness bound. Reads, validation-only calls and exact idempotency replays do not advance it.

- The `sync_creatives` assignment exemption is removed: applied assignment changes advance the revision of each affected media buy.
- Seller-optimized allocation advances the revision when reported caps, targets, pacing or lifecycle state change. In-cap spend distribution does not.
- Externally originated changes append media-buy `history` entries whose actor uses the account change feed's `origin.kind` vocabulary.
- Creative reads gain an optional seller-maintained `seller_revision`, distinct from the buyer-assigned `revision_id`. Package, creative assignment, audience, catalog, event source, property list, product and signal revisions are deferred to 3.4.

## Rationale

Without the rule, a seller operator's edit in a connected ad server leaves the revision unchanged, and a buyer's `update_media_buy` with a stale `revision` can silently undo it. The working group approved the rule in Session B (2026-10-19) on audit-trail grounds: even a change the process allows must advance the revision, so the buyer can see it happened.

## Implications

This is a normative tightening listed in the 3.3 exceptions table. Buyers that update without re-reading receive more `CONFLICT`, by design. A 3.2-pinned buyer that syncs creatives and then updates with a stale `revision` receives `CONFLICT` from a 3.3 seller. It is not eligible for a 3.2.x patch. The change feed's `resource_revision` carries these revisions where a family defines one.

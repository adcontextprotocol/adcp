---
id: DR-XXXX
title: Media-buy lineage is forward-only, same-seller, and set once at creation
class: normative
status: proposed
date: 2026-10-08
refs: ["#5849"]
dissent: none
---

The `DR-XXXX` number and this filename are placeholders. The number is assigned at merge.

## Decision

A media buy MAY name the earlier buy it succeeds through optional `predecessor_media_buy_id` plus a closed `lineage_reason` enum (`renewal`, `terms_change`, `migration`, `sunset`; other reasons go in `ext`), set once at creation on `create_media_buy`, `buy_products`, and `accept_proposal` (when it creates a new MediaBuy). `get_media_buys` echoes both fields and accepts a `predecessor_media_buy_id` filter for reverse lookup.

- The link is forward-only. The seller writes nothing onto the predecessor, so canceled and completed buys are never mutated.
- The predecessor MUST be an existing buy of the same seller and the same account. Anything else is rejected with `MEDIA_BUY_NOT_FOUND` (inaccessible predecessor) or `INVALID_REQUEST` (unpaired fields, or a link on an amendment or cancellation acceptance). The predecessor need not be terminal.
- Cycles cannot form, because the link is set once and must name an already-existing buy. There is no depth limit and no new error code.
- A seller that cannot record the link rejects with the existing `UNSUPPORTED_FEATURE` rather than creating an unlinked buy.
- The surface is stable, not experimental.

## Rationale

The symmetric model, with a seller write-back of `replacement_media_buy_id`, needs sellers to mutate canceled or completed buys, which most platforms cannot do. Cross-seller lineage needs a global buy ID, and `media_buy_id` is seller-namespaced. Forward-only same-seller lineage serves spend continuity, pacing baselines, and dispute context without either prerequisite. A closed enum lets buyers branch on the reason, which free text does not.

## Implications

Cross-seller lineage and global buy IDs are deferred to 4.0. Symmetric write-back is revisited only if a platform can mutate terminal buys. Seller-initiated replacement offers (#5683) are a separate flow and would be one producer of these links. This is standalone, not part of the post-acceptance lifecycle epic (#7064), which can consume lineage. Same-account scope is deliberate and may be revisited for agency or account migrations once a cross-account identity story exists. The protocol does not limit how many buys name the same predecessor.

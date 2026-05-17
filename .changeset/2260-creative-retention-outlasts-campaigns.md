---
"adcontextprotocol": minor
---

Creative retention contract (#2260): creatives outlast campaigns, with mandatory state-change signalling.

Resolves the 3.0 ambiguity in `docs/creative/creative-libraries.mdx` ("Retention of unassigned creatives is seller-defined") without mandating a numeric retention floor that no industry platform publishes uniformly (GAM is indefinite; Meta ~37 months; FreeWheel 25 months; most others publish nothing). The protocol surface buyers actually need is observability of state changes, not a fixed number.

**Library lifecycle is independent of buy lifecycle.** A creative MUST persist in the library regardless of the status of the buys that referenced it. Buy rejection, cancellation, or completion releases assignments only. This holds for `sync_creatives`, inline creatives on `create_media_buy`, and platform-native uploads — no carve-out by submission path, and no carve-out by creative composition (assets, brief, brand+catalog pointers, or any combination).

**State changes are observable.** When a seller archives an unassigned creative, expires it for inactivity, or revokes a previously-approved creative, the seller MUST signal the change. For creatives with active assignments the signal is an `impairment` on the buy (existing mechanism from the dependency-impact cluster). For creatives with no active assignments the signal is a creative state-change notification on the buyer's registered channel — transport mechanics are owned by #2261.

**`creative-status.json` `archived` enumDescription** widened to acknowledge that archive can be buyer- or seller-initiated and to require the state-change signal when seller-initiated on a buyer-synced creative. No new enum values; no new fields. Additive description-only change.

Variant addressability — whether a format's rendered outputs (PMax-style fan-out, `responsive_creative`, `agent_placement`) carry per-variant IDs — is a format-level concern, handled in RFC #3305 / #3307, not a library-retention concern.

Closes #2260. Refs #2261 (webhook mechanics), #2254 (parent media-buy lifecycle issue, already closed), #3305 / #3307 (format-level variant addressability).

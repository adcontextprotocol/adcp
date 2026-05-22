---
"adcontextprotocol": minor
---

Creative retention contract (#2260): creatives outlast campaigns, with mandatory state-change signalling.

Resolves the 3.0 ambiguity in `docs/creative/creative-libraries.mdx` ("Retention of unassigned creatives is seller-defined") without mandating a numeric retention floor that no industry platform publishes uniformly (GAM is indefinite; Meta ~37 months; FreeWheel 25 months; most others publish nothing). The protocol surface buyers actually need is observability of state changes, not a fixed number.

**Library lifecycle is independent of buy lifecycle.** A creative MUST persist in the library regardless of the status of the buys that referenced it. Buy rejection, cancellation, or completion releases assignments only. This holds for `sync_creatives`, inline creatives on `create_media_buy`, and platform-native uploads — no carve-out by submission path, and no carve-out by creative composition (assets, brief, brand+catalog pointers, or any combination).

**State changes are observable.** When a seller archives an unassigned creative, expires it for inactivity, or revokes a previously-approved creative, the seller MUST make the new state observable. For creatives with active assignments the signal is an `impairment` on the buy (existing mechanism from the dependency-impact cluster). For creatives with no active assignments the conformant signal today is the `status` value visible on the next `list_creatives` read — consistent with the [snapshot-and-log contract](docs/protocol/snapshot-and-log.mdx) which already names `list_creatives` as the reliable signal for resource-state changes outside an active buy. A push channel for account-scoped creative state changes is being defined under #2261; once that channel ships, sellers SHOULD additionally fire on it.

**Library can be a view, not a separate store.** Sellers whose underlying ad server has no library object distinct from per-buy attachment (some CTV/podcast stacks) satisfy "creatives outlast campaigns" by exposing the buyer-synced creative through `list_creatives` for the buy's lifetime and continuing to expose its terminal state after teardown.

**`creative/specification.mdx` state machine** updated to add an `approved → archived` (seller-initiated) edge, scoped to creatives without active package assignments. Sellers MUST NOT seller-archive a creative with active assignments — the existing `approved → rejected` (revocation) path with an `impairment` on the affected buy is the only conformant route when active serving is involved. The state-machine diagram and rule list both reflect the new edge.

**`creative-status.json` `archived` enumDescription** widened to acknowledge that archive can be buyer- or seller-initiated, to constrain seller-initiated archive to creatives without active assignments, and to pin the conformant signal to `list_creatives` until the push channel ships. No new enum values; no new fields. Additive description-only change.

Variant addressability — whether a format's rendered outputs (PMax-style fan-out, `responsive_creative`, `agent_placement`) carry per-variant IDs — is a format-level concern, handled in RFC #3305 / #3307, not a library-retention concern.

Closes #2260. Refs #2261 (webhook mechanics), #2254 (parent media-buy lifecycle issue, already closed), #3305 / #3307 (format-level variant addressability).

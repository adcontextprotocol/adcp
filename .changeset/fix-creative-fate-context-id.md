---
---

Storyboard: `creative_fate_after_cancellation` — use literal
`acme_reuse_banner_001` in the `reassign_creative` step instead of
`$context.creative_id`.

The prior shape populated the context key from the seller's
`sync_creatives` response at `creatives[0].creative_id`. Sellers whose
response envelope doesn't surface the id at exactly that path resolve
to `undefined`, the template engine strips the creative entry, and the
`creatives` array arrives at `@adcp/client`'s zod pre-flight as
`undefined` — failing with "expected array, received undefined" before
the request reaches the agent.

The literal id is buyer-authoritative (set in phase 1's
`sync_creative_with_assignment`) and matches the narrative at lines
369–371 ("Reference the original creative by creative_id only").
Robust against seller envelope variance.

Closes #2850.

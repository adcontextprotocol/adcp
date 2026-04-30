---
"adcontextprotocol": minor
---

Add `package.committed_metrics` and `package.committed_vendor_metrics` —
frozen snapshots of the product's `reporting_capabilities.available_metrics`
and `vendor_metrics` stamped at `create_media_buy` response time. Closes
#3481.

**The audit gap.** PR #3472 established that the product's
`available_metrics` becomes the binding reporting contract carried into
the resulting media buy. That holds **only if** the product is immutable
AND the seller stores a snapshot at buy creation. Neither is guaranteed:

- Products mutate (sellers add/remove metrics from `available_metrics`
  as their reporting infrastructure evolves)
- Without a per-package snapshot, `missing_metrics` on
  `get_media_buy_delivery` is computed against "what the product
  *currently* advertises" — a 90-day-old buy is incorrectly judged as
  "clean" because the seller quietly dropped a metric they originally
  committed to
- An ops team auditing a 90-day-old buy will not trust an implicit
  contract reference

This was flagged on PR #3472 by the product expert as the primary
sell-side audit gap.

**Changes.**

- `core/package.json`: new `committed_metrics: AvailableMetric[]` field
  and new `committed_vendor_metrics: { vendor, metric_id }[]` field. Both
  optional in v1; sellers without per-package snapshot infrastructure
  fall back to the product's live state (absence is conformant). Both
  MUST NOT change post-creation — `update_media_buy` cannot modify them.
  Renegotiating the metric contract requires a new buy.
- `media-buy/get-media-buy-delivery-response.json`: `missing_metrics`
  description updated to declare the reconciliation source — when
  `committed_metrics` is present, that is the contract; when absent,
  fall back to the product's current `available_metrics`.
- `docs/media-buy/task-reference/create_media_buy.mdx`: new "Reporting
  contract on confirmed packages" subsection documenting the snapshot
  semantics, immutability, and v1-optional posture.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: bullet
  updated to point at the reconciliation source.

**Design choices spelled out (resolves the three open questions on #3481).**

1. **Optional or required?** Optional. Forcing the snapshot at v1 would
   break existing implementations on first deployment. Optional with a
   doc note that "buyers SHOULD reconcile against `committed_metrics`
   when present and fall back to the product's live state when absent"
   lets sellers adopt incrementally. Expected to become required at the
   next major.

2. **What snapshots into `committed_metrics`?** The product's full
   `reporting_capabilities.available_metrics` at the moment of
   `create_media_buy`, NOT the intersection with the buyer's
   `required_metrics` filter. The product committed to reporting all
   those metrics; reducing to the intersection would silently drop
   reporting on metrics the buyer didn't explicitly list but the seller
   still has. `requested_metrics` (on `reporting_webhook`) remains the
   buyer's payload-optimization filter — a separate concept.

3. **Mutation policy?** Frozen at creation, MUST NOT change post-creation.
   `update_media_buy` cannot modify `committed_metrics` or
   `committed_vendor_metrics`. If the buyer/seller need to renegotiate,
   that's a new buy. This is the cleanest contract; mutability with
   audit trail can be added later if real demand emerges.

**Backwards compatibility.** Optional and additive. Sellers without
snapshot infrastructure fall back to the implicit contract (product's
current state) — this matches the v1 behavior of #3472. Buyers can
incrementally upgrade to consume `committed_metrics` when present.

Closes #3481.

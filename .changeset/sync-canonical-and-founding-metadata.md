---
---

Make /sync canonical, recognize founding-era subs by product metadata, unblock the integrity runner in production.

Follow-up to #3812 — that PR locked down the dashboard fallback and added the resolver-level invariant. This PR fixes the three remaining gaps that the Adzymic incident exposed:

- **`POST /api/admin/accounts/:orgId/sync` was incomplete.** The inline UPDATE wrote 6 fields and silently dropped `stripe_subscription_id`, `subscription_price_lookup_key`, `subscription_product_id/name`, and `membership_tier`. Every successful sync left the row in the same partial-truth state the new invariant flags. Now uses `buildSubscriptionUpdate()` — same writer the webhook handler runs — so /sync, webhooks, and lazy-reconcile all produce identical row state.
- **Founding-era Stripe prices have no `aao_membership_*` `lookup_key`.** They were created in the Stripe Dashboard before the convention existed, and rely on `metadata.category = "membership"` on the product instead. Without recognizing this, `pickMembershipSub` filtered them out — `/sync` reported "no membership sub found" for paying customers (Adzymic, Advertible, Bidcliq, Equativ — May 2026), and the `stripe-sub-reflected-in-org-row` invariant's orphan-customer detection never saw them either. `isMembershipSub` now falls back to product metadata; `/sync` and the invariant both expand `price.product` so the metadata is available.
- **`detectEnvMismatch()` refused to run integrity checks in prod.** The hostname allowlist had `*.fly.dev` but not Fly's actual private-service patterns (`*.flycast`, `*.internal`). The prod `DATABASE_URL` host didn't match, the runner classified live as "not prod", and refused with "live key against staging" in production. Allowlist now includes the real Fly patterns plus a positive `FLY_APP_NAME` signal.

Tests cover: metadata-fallback in `isMembershipSub` / `pickMembershipSub`, the broadened invariant against the Bidcliq shape (founding sub with no lookup_key, customer not linked to any AAO org), and the existing happy paths. The narrowing test ("skips subs with no lookup_key") was kept and tightened — it now requires both no lookup_key *and* non-membership product metadata.

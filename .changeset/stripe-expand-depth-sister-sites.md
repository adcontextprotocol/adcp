---
---

Drop over-deep Stripe expand at three sister sites the /sync hotfix (#3853) didn't reach. All three had been throwing on Stripe's 4-level expand limit:

- `dedup-on-subscription-created` — `data.items.data.price.product` (5 levels) on `subscriptions.list`. The catch swallowed the error and fell through to `no_duplicate`, silently disabling the cross-path duplicate-subscription guard from #3245. Drop the product leg of the expand; tier label degrades to `lookup_key` (already the existing fallback).
- `stripe-sub-reflected-in-org-row` invariant — `data.items.data.price.product` (5 levels) on `subscriptions.list`. The integrity check threw on every run, so the Lina/Adzymic-class detection wasn't actually firing. Drop expand; classify by lookup_key with a per-product `products.retrieve` fallback (cached across the run) for founding-era subs.
- `/api/admin/backfill-revenue` — `subscriptions.data.items.data.price.product` (6 levels) on `customers.retrieve`. Whole loop crashed per customer. Replace with `subscriptions.list` + `pickMembershipSubWithProductFetch`, mirroring the /sync fix.

Adds shared helper `isMembershipSubWithProductFetch` in `billing/membership-prices` for the per-sub filter case.

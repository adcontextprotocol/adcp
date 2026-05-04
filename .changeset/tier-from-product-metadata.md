---
---

Resolve membership tier from Stripe product `metadata.tier` when `lookup_key` is locked.

Founding-era prices are auto-created by Stripe (manual invoice lines, Payment Links) and have an immutable `lookup_key` field — Stripe rejects edits with "The price was created by Stripe automatically and cannot be updated." Combined with `unit_amount=0` (the year is prepaid via separate one-time invoice), the existing tier resolver had no signal to work with: `tierFromLookupKey(null)` returned null and `inferMembershipTier(0, ...)` returned null too.

This adds a third path in `buildSubscriptionUpdate` that reads `product.metadata.tier`. Setting `tier: company_standard` on the Founding Startup/SMB **product** (its metadata is editable, unlike the price's lookup_key) now resolves Advertible-class orgs to Builder. Same pattern works for the Founding Corporate product → `tier: company_icl`.

Resolver chain (priority order):
1. `lookup_key` on price — modern convention, fastest
2. `metadata.tier` on product — for founding-era prices with locked lookup_keys
3. `unit_amount` + `interval` + `is_personal` inference — last resort, fails on $0 comp-style subs

`pickMembershipSubWithProductFetch` now returns `{ sub, product? }` so callers (admin /sync, admin sync-stripe-customers) can pass the metadata to `buildSubscriptionUpdate` without a second `products.retrieve` round-trip. Webhook handlers continue to work — they receive subs with product expanded inline, and the resolver reads the metadata directly off `subscription.items.data[0].price.product` when no caller-supplied metadata is provided.

Tests: 22 new cases in `build-subscription-update.test.ts` covering each branch of the chain, lookup_key precedence over metadata, status-gated behavior, and conservative rejection of unknown tier values.

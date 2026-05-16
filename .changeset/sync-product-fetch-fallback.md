---
---

Fix /sync founding-cohort recovery — drop over-deep Stripe expand, fetch product per-sub.

Hotfix on top of #3850. The previous attempt expanded `data.items.data.price.product` on `subscriptions.list`, which is 5 levels deep and still over Stripe's 4-level expansion limit. /sync continued to fail for every org.

New approach: list subs without product expansion (the `lookup_key` fast path is enough for the modern cohort), and only when no sub has a recognized lookup_key, fall back to retrieving the product per candidate via `stripe.products.retrieve` to check `metadata.category=membership`. Founding-era subs (Adzymic, Advertible, Bidcliq, Equativ — May 2026) recover through this path; modern subs cost zero extra round-trips.

New `pickMembershipSubWithProductFetch` async helper. Sync `pickMembershipSub` is unchanged for callers (integrity invariants) that walk every sub on the account and can't afford per-sub Stripe round-trips.

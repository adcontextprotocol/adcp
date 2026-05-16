---
---

fix(compliance): inventory_list_targeting — add `sandbox: true` to account fixtures

The 5 account blocks across this scenario use the brand+operator natural-key variant of `AccountReference` but omit the `sandbox` flag. Sellers whose `accounts.resolve` has separate code paths for sandbox vs production refs end up routing `create_media_buy` and `get_media_buys` through different account-id namespaces, which breaks `mediaBuyStore` backfill of `targeting_overlay` and fails `verify_create_persisted` / `verify_update_persisted`.

Setting `sandbox: true` on every account block keeps both create and get on the sandbox path, the round-trip becomes consistent, and the storyboard exercises what it intended to: targeting persistence across the create / get / update lifecycle.

Non-protocol (storyboard fixture only). No version bump.

Refs: adcp-client#1487 — follow-up to fix the underlying enricher asymmetry upstream so future storyboard authors don't trip the same wire.

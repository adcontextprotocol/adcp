---
"adcontextprotocol": minor
---

Add `redirect_reason` and `redirect_effective_at` to both redirect variants in `brand.json` (Authoritative Location Redirect and House Redirect).

Today, when a brand.json transitions from a portfolio document to a redirect (e.g., during M&A — Dentsu becomes a House Redirect to WPP), DSPs / crawlers / prebid configs sit on stale cached state for whatever their TTL is. Free-text `note` is human-readable but not machine-parseable.

`redirect_reason` is an enum (`acquisition`, `divestiture`, `rebrand`, `regional`, `legacy`, `consolidation`, `other`) that consumers SHOULD use to inform cache TTL: in-transition reasons (`acquisition`, `divestiture`, `rebrand`, `consolidation`) suggest the resolved target is moving and consumers SHOULD shorten cache TTL until stable; stable reasons (`regional`, `legacy`) keep standard caching.

`redirect_effective_at` is an ISO 8601 timestamp. Caches **MUST** treat any entry cached before this timestamp as stale and re-fetch through the redirect — this is the hard invariant that closes the cache-poisoning gap during transitions, regardless of TTL.

Both fields are optional and additive. Existing redirect publishers continue to work unchanged.

Motivated by review of the distributed brand.json RFC ([#3533](https://github.com/adcontextprotocol/adcp/pull/3533)) — the M&A migration story uses existing redirect variants, and this PR makes that ergonomic.

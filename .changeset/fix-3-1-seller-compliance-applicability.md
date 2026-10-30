---
"adcontextprotocol": patch
---

Correct media-buy compliance fixtures for auction-only AdCP 3.1 sellers. Price-independent tests use non-guaranteed CPM floors and supply valid bids. Channel fixtures use the 3.1 enum, including `olv` for online video.

Optional metric and canonical-format scopes discover native support before seeding supported fixtures. Canonical compatibility requires explicit 3.1 `canonical_creatives` support; custom and experimental declarations have independent applicability. Currency checks use effective account pricing, preserve valid empty results, and avoid rate-card identity or ordering assumptions. Product-filter checks no longer seed unsupported guaranteed inventory.

The maintenance server retains its production SDK. Regression and manual compliance runners use an isolated modern test-only SDK and the immutable 3.1 schema snapshot. Discover-before-seed and complete filter semantics require a compatible modern compliance runner; published versioned artifacts remain unchanged until the next patch release.

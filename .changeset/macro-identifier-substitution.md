---
"adcontextprotocol": minor
---

Add a seller-scoped compliance storyboard for media-buy identifier substitution in tracking URLs.

`static/compliance/source/universal/macro-identifier-substitution.yaml` creates a media buy, submits a creative whose impression tracker uses `{MEDIA_BUY_ID}` and `{PACKAGE_ID}`, and asserts the seller substituted the real identifiers.

> **Deferred / draft.** The driving assertion (`expect_universal_macro_substituted`) was pulled from `@adcp/sdk` (adcontextprotocol/adcp-client#2263): observing a `build_creative` preview can't certify substitution that resolves at serve time. This storyboard is parked pending the Live Integration (decisioning-roundtrip) check and will be reworked against that surface.

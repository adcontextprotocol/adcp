---
"adcontextprotocol": minor
---

Add a seller-scoped compliance storyboard verifying media-buy identifier substitution in tracking URLs, and document the SDK translation helper.

`static/compliance/source/universal/macro-identifier-substitution.yaml` creates a media buy, submits a creative whose impression tracker uses `{MEDIA_BUY_ID}` and `{PACKAGE_ID}`, and asserts (via the `expect_universal_macro_substituted` assertion) that the seller's rendered preview carries the real identifiers. Sellers without an observable preview surface are recorded as not_applicable rather than failed.

`docs/creative/universal-macros.mdx` gains an "Implementing translation with the SDK" example showing `universal_macro_translation` from `@adcp/sdk` (native tokens inserted raw, value entries RFC-3986 encoded, unmapped-macro params dropped, minted params untouched).

Depends on adcontextprotocol/adcp-client#2263, which ships the `expect_universal_macro_substituted` assertion and `universal_macro_translation` helper in `@adcp/sdk`. The `@adcp/sdk` dependency bump lands once that publishes.

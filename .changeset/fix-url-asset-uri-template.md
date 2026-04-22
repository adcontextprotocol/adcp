---
"adcontextprotocol": patch
---

Relax `core/assets/url-asset.json` `url.format` from `uri` to `uri-template` (RFC 6570).

The prose spec (`docs/creative/universal-macros.mdx:575-585`) explicitly requires buyers to submit tracker URLs with raw AdCP macros like `{SKU}` / `{DEVICE_ID}` / `{MEDIA_BUY_ID}` at sync time — the ad server URL-encodes substituted values at impression time. Strict `format: uri` rejected those templates, which contradicted the spec and broke the `sales-social/catalog_driven_dynamic_ads/sync_dpa_creative` compliance fixture that was built against the prose convention (60 lint errors against every anyOf branch of creative-manifest.assets).

`uri-template` accepts both plain URIs and RFC 6570 level-1 templates (`{var}`), which is exactly the shape AdCP universal macros produce. The description now spells out the sync-time-raw / impression-time-encoded split so future fixture authors don't pre-encode.

Surfaced by PR #2801 review (ad-tech-protocol-expert) after an initial misread of the step's impression-time-output narrative led to the wrong fix direction.

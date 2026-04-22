---
"adcontextprotocol": patch
---

Relax `core/assets/url-asset.json` `url.format` from `uri` to `uri-template` (RFC 6570).

The prose spec (`docs/creative/universal-macros.mdx`) explicitly requires buyers to submit tracker URLs with raw AdCP macros like `{SKU}` / `{DEVICE_ID}` / `{MEDIA_BUY_ID}` at sync time — the ad server URL-encodes substituted values at impression time. Strict `format: uri` rejected those templates, which contradicted the spec and broke the `sales-social/catalog_driven_dynamic_ads/sync_dpa_creative` compliance fixture that was built against the prose convention (60 lint errors against every anyOf branch of creative-manifest.assets).

`uri-template` accepts both plain URIs and RFC 6570 Level 1 templates (`{var}`), which is exactly the shape AdCP universal macros produce. The description now spells out the sync-time-raw / impression-time-encoded split so future fixture authors don't pre-encode. Also adds a Template Syntax section to `universal-macros.mdx` explicitly scoping AdCP to Level 1 — Level 2–4 operators (`{+var}`, `{#var}`, `{.var}`, `{/var}`, `{;var}`, `{?var}`, `{&var}`) are not used.

**SDK migration note.** Any buyer-side SDK that defensively percent-encodes `{` / `}` in outbound `sync_creatives` payloads should stop — raw braces are now the canonical wire form at sync time. Pre-encoded macros never worked correctly in the first place (the ad server cannot find `%7BSKU%7D` to substitute) but some SDKs defensively encoded to satisfy strict uri validators; the schema relax removes the need.

Scope note. Only `url-asset.json` is touched. Other asset schemas (image, video, audio, vast, daast, webhook) keep `format: uri` because their url fields point to dereferenceable CDN assets or live endpoints that the ad server fetches directly — never impression-time substituted.

Surfaced by PR #2801 review (ad-tech-protocol-expert) after an initial misread of the step's impression-time-output narrative led to the wrong fix direction.

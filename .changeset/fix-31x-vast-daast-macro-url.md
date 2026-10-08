---
"adcontextprotocol": patch
---

fix(schema): backport macro-bearing-url to 3.1.x — VAST/DAAST asset `url` fields accept GAM-style `%%MACRO%%` tokens

The 3.1 `vast-asset.json` and `daast-asset.json` declared `url` as `format: uri-template`,
rejecting ordinary GAM/CM360/DV360 VAST tags (`%%CACHEBUSTER%%`, `%%PATTERN:url%%`) under
strict validation, while 3.2 accepts them via `core/macro-bearing-url.json`. Backports the
3.2 `macro-bearing-url` schema (adapted to the relative `$id` form used by the 3.1.x
schema series) and switches both asset `url` fields to `$ref` it. Pure relaxation: the
first `anyOf` branch preserves every previously-valid `uri-template` value. No previously-
conformant implementation can fail. Fixes #7993.

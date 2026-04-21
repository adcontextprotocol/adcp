---
---

Bundler: hoist nested `$defs` / `definitions` blocks to the document root when generating `bundled/*` schemas. Previously, local `#/$defs/...` pointers authored inside referenced schemas (e.g. `format.json`, `policy-entry.json`, `artifact.json`) landed deep inside the bundled output while their refs still pointed at the document root, making the bundled schemas unresolvable for draft-07 validators like Ajv. Affected consumers: any client compiling `list_creative_formats` or `list_content_standards` bundled responses. Fixes #2648.

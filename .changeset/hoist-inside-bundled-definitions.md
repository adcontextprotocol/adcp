---
"adcontextprotocol": patch
---

Bundled schemas (`/schemas/{version}/bundled/`) now hoist marked schemas (`x-adcp-hoist`) and repeated enums that sit inside a `definitions` or `$defs` entry, such as the `definitions` of an inlined schema, to root `$defs`, as they already did everywhere else. The entry itself is still not counted or replaced. 29 of 124 bundles shrink, and `creative/list-creatives-response.json` goes from 4.1 MB to 1.7 MB. Source schemas, validation and each site's annotations are unchanged.

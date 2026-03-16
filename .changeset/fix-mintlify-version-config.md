---
---

fix: use correct Mintlify versioning config format

Moved default version flag from `navigation.default` to `"default": true` on
the version object. The previous format was not recognized by Mintlify, causing
it to ignore versioning entirely and 404 all v2.5 doc pages.

---
"adcontextprotocol": patch
---

Add schema link checker workflow for docs PRs. The checker validates that schema URLs in documentation point to schemas that exist, and warns when schemas exist in source but haven't been released yet.

Also updates sync_audiences schema links from v1 to v3 - the links will work once the next beta release (3.0.0-beta.4) is published.

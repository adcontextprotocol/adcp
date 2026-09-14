---
"adcontextprotocol": patch
---

Fix external HTTP links in public perspective articles being stripped by DOMPurify. The URI allowlist only accepted `https:` schemes, causing `http:` links (e.g. YouTube) to render as dead anchor tags with no href.

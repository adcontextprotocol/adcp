---
"adcontextprotocol": minor
---

Make `account` optional in `get_media_buys` request — when omitted, returns data across all accessible accounts. Add backward-compatibility clause to `get_products`: sellers receiving requests from pre-v3 clients without `buying_mode` should default to `"brief"`.

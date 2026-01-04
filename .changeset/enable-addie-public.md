---
"adcontextprotocol": patch
---

Enable Addie chat for all users in main navigation

- Remove admin-only restriction on "Ask Addie" link in nav.js
- Add membership tier guidance to Addie's system prompt to prevent hallucinating tier names like "silver" or "gold"
- Addie now always uses find_membership_products tool for current pricing

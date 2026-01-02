---
"adcontextprotocol": patch
---

Add role-aware dynamic suggestions for Addie

- Admin users now see admin-specific suggestions (pending invoices, company lookup, prospect pipeline)
- Deprecate AAO bot slash commands - Addie now uses get_account_link tool for direct sign-in links
- Extract buildDynamicSuggestedPrompts to shared module to reduce code duplication

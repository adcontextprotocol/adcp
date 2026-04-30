---
---

Add smart paste import for brand.json properties: AI-powered parse endpoint (`POST /api/brands/:domain/properties/parse`) and brand builder UI panel. Accepts pasted text (domains from spreadsheets, emails, free-form) or a public URL (CSV, Google Sheets). Claude (fast model) extracts identifiers and types; user confirms before the existing bulk merge API commits the write.

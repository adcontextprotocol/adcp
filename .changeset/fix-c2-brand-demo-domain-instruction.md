---
---

Fix C2 sandbox brand demo: Sage was passing demo.example.com as a brand_id to
get_brand_identity (REFERENCE_NOT_FOUND), because the system prompt emitted
"Use brand domain demo.example.com for the account" unconditionally for all
active modules. Removed the unconditional instruction; made the per-lesson demo
block emit tool-specific guidance (buyer domain only for acquire_rights/sync_accounts,
brand_id reminder only for get_brand_identity). Also de-hardcoded the get_products
reference in the generic teaching rules so non-sales-track modules don't get
wrong tool guidance.

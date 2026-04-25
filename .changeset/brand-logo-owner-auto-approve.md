---
---

Server: auto-approve logo uploads from verified domain owners. Defines a single policy rule for `brand_logos.review_status` based on upload source (`brand_owner` → approved, `community` → pending). Fixes the asymmetry between the multipart upload path and the `update_company_logo` tool that caused verified owners' logos to sit invisible in the moderation queue. Closes #3150.

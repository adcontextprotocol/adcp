---
---

Add `POST /api/me/organization/domains` (issue WorkOS DNS-TXT challenge) and `POST /:domain/verify` (confirm + flip `verified=true source='workos'`) so owners and admins can attach and verify a new brand domain from `/member-profile` without admin intervention. The existing `PUT /:domain/primary` already accepts `source='workos'` rows, so once the member verifies they can set primary themselves and the dashboard's Public visibility toggle unblocks. The issue path is cross-tenant safe: it pre-checks for a local row owned by another org and returns 409 cleanly instead of transferring ownership without DNS proof. Verify has a 60s per-(org, domain) cooldown to stop agentic loops from polling on `still_pending`.

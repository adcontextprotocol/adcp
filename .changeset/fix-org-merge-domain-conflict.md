---
---

Surface the actual error in `/api/admin/cleanup/merge` 500 responses.

The merge route caught any error and returned `{"error": "Internal server error"}` with no detail. Admins running merges via curl had no idea which step failed, whether the txn rolled back, or what to retry. May 2026 Media.net-2 cleanup lost ~30min on this — the merge endpoint kept returning a bare 500 with no diagnostic, even after the secondary org had successfully been deleted.

Now:
- 500 response includes `details` with the underlying error message.
- Log line includes `name`, `stack`, `cause`, `primary_org_id`, `secondary_org_id`.
- Destructure of req.body moved out of the try-block so the catch path can reference which org pair was being merged.

(I also tried to fix what I thought was a `UNIQUE(domain)` conflict in `org-merge-db.ts` but the schema makes that state unreachable — two rows can't both own the same domain. Reverted that part. The real failure mode for Media.net-2 was something else, and we couldn't see it because the route was swallowing errors. After this lands, next merge failure will surface the actual cause.)

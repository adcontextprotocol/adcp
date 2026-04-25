---
---

Brand logos uploaded by a verified domain owner now auto-approve and rebuild the manifest immediately, instead of sitting in the pending review queue. Closes #3150 (the policy half — community uploads and the brand_logos default still queue, which is intentional).

Concretely: when `POST /api/brands/:domain/logos` runs, we check `isVerifiedBrandOwner(user.id, domain)` (existing helper, now exported) and set `source: 'brand_owner', review_status: 'approved'` if true. Verified hosted brands skip the manifest rebuild because they manage logos via brand.json. The pending queue stays for genuinely community-contributed logos where ownership is unclear — that's the case the moderation queue is actually for.

Resolves the upstream cause of the thehook.es escalation: Felipe's domain was verified, his uploads should never have queued.

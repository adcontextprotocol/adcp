---
---

Auto-publish a member's directory listing on fresh membership activation. Stripe `customer.subscription.created` and `invoice.paid` (non-subscription membership) now hit a new `ensureMemberProfilePublished` helper that creates a `member_profiles` row with `is_public=true` if none exists, or flips an existing unpublished row to public. Scoped to fresh activations only — `subscription.updated` (renewals, tier changes) is deliberately excluded so a manually unpublished profile isn't clobbered on the next webhook. Adds a new admin endpoint `GET /api/admin/addie/listings/unpublished-backlog` that lists orgs with an active membership whose listing is still missing or draft, for cleanup of the pre-fix backlog.

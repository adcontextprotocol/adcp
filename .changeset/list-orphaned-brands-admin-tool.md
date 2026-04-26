---
---

New `list_orphaned_brands` admin tool surfaces brands awaiting adoption — the prior owner relinquished, the manifest is preserved for the next claimant — so admins can audit the queue without raw DB access. Returns prior owner org name + id, days since relinquished, and a manifest preview (logo, color) per row.

Pairs with the existing `transfer_brand_ownership` tool: when an admin confirms the legitimate next owner out of band, run transfer to hand it off; otherwise the row sits in the orphan pool until someone claims via the normal brand-identity flow (which now requires an explicit adopt-or-clear decision).

Closes the "orphaned rows accumulate with no admin view" gap from the #3168 review.

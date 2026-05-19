---
"adcontextprotocol": minor
---

spec(media-buy): disambiguate `pending_creatives` status description.

Sharpens the enum description for `media-buy-status.pending_creatives` to remove the ambiguity raised in #4196 (readers interpreting the name as "waiting for publisher/governance approval" rather than the intended "buyer-side creative submission missing").

Document, don't rename. The wire churn of renaming the enum value isn't worth the marginal clarity gain — the existing description already named the buyer action, and `pending_X` is a consistent naming convention across the enum (`pending_start` follows the same shape: "phase X is next required", not "X is pending approval"). Renaming would force every downstream SDK, dashboard, storyboard fixture, and seller-side state machine to migrate for what is fundamentally a documentation gap.

The new description leads with **"Buyer-side action required"**, explicitly contrasts with publisher/governance approval flows ("the seller has already accepted the buy"), and names the convention so readers can apply the same parse to `pending_start` without filing a follow-up issue.

Closes #4196.

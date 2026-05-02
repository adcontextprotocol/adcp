---
---

Fix three admin-billing issues that surfaced together when unblocking a discounted founding-member invoice:

- **Stripe coupon name overflow.** `createOrgDiscount` built `${orgName} - ${discountDescription}` with no length cap, so org names longer than ~25 chars produced names exceeding Stripe's 40-char limit and the call 400'd with `Invalid string … must be at most 40 characters`. Added a `buildOrgCouponName` helper that normalizes whitespace and truncates the org portion so the composite always fits.
- **Send Membership Invitation modal still surfaced retired founding tiers.** The modal called `/api/admin/products` (the unfiltered catalog), bypassing the April-1 founding-member cutoff that lives in `getProductsForCustomer`. Added `GET /api/admin/orgs/:orgId/invite-products` that runs through the cutoff filter and switched the modal to it.
- **Modal ignored org discounts when displaying prices.** Builder shows as $3,000 even when the org has a $500 discount on file. The new endpoint also returns the org's discount fields so the modal renders `~~$3,000~~ $2,500 (-$500 off)`. Warns the admin if the org has a discount but no Stripe coupon attached (so the actual invoice would charge the sticker price).

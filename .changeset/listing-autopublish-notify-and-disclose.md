---
---

Notify admins when a membership activation auto-publishes their directory listing, and disclose the auto-publish at checkout. Follow-up to #2581 / #2583.

- The Stripe `customer.subscription.created` webhook now calls `ensureMemberProfilePublished` after the `organizations` row is updated, then threads the resulting `{ slug, action }` into the thank-you Slack DM and welcome email. When a listing is created or flipped public, admins see a new "Your listing is live" section with view, edit, and make-private links — no separate notification send. Deferring autopublish until after the org row reflects activation avoids a transient state where the listing is public but the backend hasn't recorded membership.
- `createCheckoutSession` adds `custom_text.submit.message` on membership prices (lookup keys starting with `aao_membership_` or `aao_invoice_`), disclosing that completing checkout publishes the org in the public member directory. Non-membership checkouts (event sponsorships, etc.) are unaffected.
- `ensureMemberProfilePublished` now returns `slug` on `published` and `noop` results so callers can link to the listing without an extra DB round trip.

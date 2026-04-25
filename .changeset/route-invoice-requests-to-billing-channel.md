---
---

Route invoice-request Slack notifications through the configured billing channel (`getBillingChannel`) via `notifyInvoiceSent`, instead of the catch-all `SLACK_WEBHOOK_URL`. The `notifyInvoiceSent` helper now carries the requester name and Stripe invoice ID, and sanitizes user-controlled fields against Slack mrkdwn injection.

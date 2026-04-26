---
---

Adds a customer-facing notice when the webhook dedup helper auto-resolves a duplicate subscription. Branches copy on whether money moved (refund vs. no charge) and on which sub was canceled (new duplicate vs. old unpaid intake). Sent fire-and-forget to all org admins. Closes the customer-apology sub-item of #3245.

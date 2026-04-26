---
---

Replaces the dedup helper's "always cancel newer" policy with "cancel the unpaid one when exactly one is unpaid." Determines paid/unpaid via `latest_invoice.status === 'paid'`. When zero or multiple subs are unpaid, the helper now refuses to auto-cancel and emits a `manual_review` outcome with full context for ops. Webhook handler updated to handle the new four-way outcome (`no_duplicate` | `canceled_new` | `canceled_existing` | `manual_review`). Closes the cancel-newer sub-item of #3245.

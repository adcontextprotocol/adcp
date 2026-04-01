---
---

Fix list_paying_members returning incomplete results: raise default limit from 50 to 200 (max 500), include members with past_due/unpaid subscriptions flagged in output, add truncation warning when results are capped.

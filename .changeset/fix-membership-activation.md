---
---

fix: prevent agreement recording failure from blocking membership activation

- Agreement recording errors in the subscription webhook are now non-blocking so the subscription sync (status, tier, period) always completes
- Non-subscription membership renewals now update subscription_current_period_end even when already active
- Added missing escapeHtml on product lookup_key in new-subscriber checkout cards

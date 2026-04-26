---
---

Persists webhook-side dedup decisions to `registry_audit_log` (action: `subscription_dedup`) and adds a "Dedup Events" button + modal on the admin org detail page so admins can retroactively see which subscriptions the helper canceled, when, and why. Closes the admin-UI sub-item of #3245.

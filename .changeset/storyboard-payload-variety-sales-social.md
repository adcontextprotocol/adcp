---
---

Enrich `sales_social` storyboard payloads to catch façade adapters: add `add[]` hashed-identifier members to the `sync_audiences` step, add response validations for `action` and `uploaded_count`, add `user_match` to `log_event` events, and move `value`/`currency` into the correct `custom_data` wrapper. Closes #3785.

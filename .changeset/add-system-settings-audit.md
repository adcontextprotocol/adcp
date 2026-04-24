---
---

Add audit history table for system_settings changes. Records every setSetting call (key, old_value, new_value, changed_by, changed_at) using an atomic writable CTE. Surfaces the last 50 changes in a new "Recent changes" section on the admin settings page. Also adds the editorial and announcement channel UI sections that were missing from admin-settings.html.

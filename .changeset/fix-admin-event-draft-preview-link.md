---
---

fix(admin): add Preview link for draft events and visibility/status help text

Adds a "Preview" link to draft events in the admin event list so admins can navigate to `/events/{slug}` and see the existing draft-preview banner. Also adds a "View" link for published/completed events. Adds `<small>` help text beneath the Status and Visibility dropdowns to explain that status=Published (not visibility) is what makes an event publicly accessible — the root cause of the visibility-vs-status confusion reported in #2536.

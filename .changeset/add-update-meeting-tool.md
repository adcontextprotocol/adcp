---
---

feat: Add update_meeting tool to Addie

Added a new tool that allows updating existing meetings through conversation:
- Change title, description, or agenda
- Reschedule to a new time (properly handles timezone conversion)
- Update duration

Updates are synchronized to Zoom and Google Calendar when those integrations
are configured. This enables fixing meeting times or details without having
to cancel and recreate.

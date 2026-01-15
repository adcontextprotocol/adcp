---
---

fix: Strip Z suffix from Google Calendar dateTime to fix timezone

Applied the same timezone fix to Google Calendar events that was applied to
Zoom meetings. The Z suffix was causing Google Calendar to interpret times
as UTC, resulting in meetings showing 5 hours earlier than intended for ET.

For example, "1 PM ET" was showing as "8 AM ET" because the Z suffix told
Google Calendar the time was 13:00 UTC (which is 8 AM ET).

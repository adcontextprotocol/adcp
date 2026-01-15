---
---

fix: Strip Z suffix from Zoom meeting start_time

When creating Zoom meetings, toISOString() was adding a Z suffix which made
Zoom interpret times as UTC instead of the specified timezone. A meeting for
"11 AM ET" was being scheduled for 11:00 UTC = 6:00 AM ET.

Fixed by stripping the Z suffix so Zoom interprets the time in the timezone
parameter (e.g., America/New_York).

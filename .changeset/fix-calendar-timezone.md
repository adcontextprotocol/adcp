---
---

fix: Parse meeting times in specified timezone correctly

Fixed timezone handling end-to-end:
- Added parseDateInTimezone() to interpret input times in the target timezone
- When Claude sends "2026-01-15T13:00:00" for "1 PM ET", we now create a Date
  representing 18:00 UTC (the correct moment for 1 PM ET)
- Both display in Slack and API calls to Zoom/Calendar now show correct time
- Removed formatDateWithoutZ() workaround since Date objects are now correct

Before: "1 PM ET" → Date(13:00 UTC) → displayed as "8 AM ET", but Calendar showed 1 PM
After: "1 PM ET" → Date(18:00 UTC) → displayed as "1 PM ET", Calendar shows 1 PM

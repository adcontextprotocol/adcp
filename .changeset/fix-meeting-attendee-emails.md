---
---

fix: Meeting scheduling timezone and email issues

**Attendee emails:**
The working_group_memberships.user_email field is often NULL because it's not
always populated when members are added. Updated the query to join with the
users table to get the actual email. This fixes calendar invites not being sent.

**Zoom timezone:**
When creating Zoom meetings, toISOString() was adding a Z suffix which made
Zoom interpret times as UTC instead of the specified timezone. A meeting for
"11 AM ET" was being scheduled for 11:00 UTC = 6:00 AM ET.

Fixed by stripping the Z suffix so Zoom interprets the time in the timezone
parameter (e.g., America/New_York).

---
---

fix: Accept both UUID and Zoom meeting IDs in meeting tools

Updated meeting tools to accept both internal UUIDs and Zoom meeting IDs:
- Show meeting ID in list_upcoming_meetings output
- get_meeting_details, cancel_meeting, rsvp_to_meeting, add_meeting_attendee
  now try UUID first, then fall back to Zoom meeting ID lookup

This fixes the issue where Claude would see Zoom meeting IDs in meeting links
but the tools only accepted internal UUIDs.

---
---

fix: Get meeting attendee emails from users table

The working_group_memberships.user_email field is often NULL because it's not
always populated when members are added. Updated the query to join with the
users table to get the actual email, falling back to the cached value if needed.

This fixes calendar invites not being sent because attendeeCount was 0.

---
---

fix: Display meetings section on committee pages and add admin edit

Fixed a bug where the meetings section wasn't showing on committee detail pages.
The API returns `{ meetings: [...] }` but the code was calling `.filter()` directly
on the response object instead of `response.meetings`.

Also added edit functionality to the admin meetings page - admins can now click
"Edit" to reschedule or update meeting details (title, description, time).

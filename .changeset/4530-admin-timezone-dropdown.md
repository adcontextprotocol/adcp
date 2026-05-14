---
---

Fix #4530 — admin events + meetings forms now offer every IANA timezone, labelled by current UTC offset and sorted by offset, instead of a hardcoded list of 8. Mary hit this scheduling the Singapore meetup: `Asia/Singapore` wasn't selectable, so the form kept the `America/New_York` default and rendered the event in EST. Server-side HTML only, no schema or SDK change.

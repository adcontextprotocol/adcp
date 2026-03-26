---
"adcontextprotocol": minor
---

Add `special` and `limited_series` fields to shows and episodes. Specials anchor content to real-world events (championships, awards, elections) with name, category, and date window. Limited series declare bounded content runs with total episode count and end date. Both are composable — a show can be both. Also adds `commentator` and `analyst` to the talent role enum, and fixes pre-existing training agent bugs (content_rating mapped as array, duration as ISO string instead of integer, invalid enum values).

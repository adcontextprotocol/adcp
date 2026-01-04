---
"adcontextprotocol": patch
---

Add scheduled job to compute user engagement scores

User engagement scores were always showing as 0 because the scoring functions existed in the database but were never called. Added a periodic job that runs hourly to update stale user and organization engagement scores.

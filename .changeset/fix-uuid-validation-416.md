---
---

Validate UUID params on admin thread/message routes (returns 400 instead of 500 for malformed IDs) and handle Range Not Satisfiable errors in global error handler to stop noisy alerts

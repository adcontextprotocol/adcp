---
"adcontextprotocol": patch
---

Add retry logic with linear backoff to seat-request-reminders scheduled job and parallelize DB queries to reduce connection timeout failures

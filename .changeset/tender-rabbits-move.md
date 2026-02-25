---
"adcontextprotocol": minor
---

Add `rejected` account status for accounts that were never approved. Previously, `closed` covered both "was active, now terminated" and "seller declined the request", which was counterintuitive. Now `pending_approval` → `rejected` (declined) is distinct from `active` → `closed` (terminated).

---
"adcontextprotocol": patch
---

Fix duplicate members and broken leader permissions on chapter pages when users have both Slack and web accounts

Root cause: Users who joined via Slack had their Slack ID stored. When they later linked their WorkOS account, they had two separate records.

Solution:
- Write paths (addMembership, addLeader, setLeaders) now resolve Slack IDs to canonical WorkOS IDs before storing
- Migration 149 consolidates existing duplicate records to use WorkOS IDs
- Queries simplified since data is now clean at the source

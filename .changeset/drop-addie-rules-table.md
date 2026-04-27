---
---

Drop `addie_rules` DB table and remove dead admin UI Rules tab. Rules have been
served from `server/src/addie/rules/*.md` since PR #2028; the DB table, three
read-only GET endpoints, ~140 lines of dead DB methods, and the rule-CRUD admin
UI were all vestige. Admin Rules tab replaced with a system-prompt viewer.

---
---

fix: Clarify start_time format in meeting scheduling schema

Updated schema description to explicitly tell Claude NOT to add Z suffix to
start_time. Claude was interpreting "11 AM ET" as "11 AM UTC" with Z suffix,
causing meetings to be rejected as "already passed".

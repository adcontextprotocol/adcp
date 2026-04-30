---
---

`/admin/addie` threads filter now accepts a comma-separated list of tools (`?tool=A,B,C`) — backed by a Postgres array-overlap query rather than a single `= ANY` lookup. Adds a "Person tools" preset button on the threads page that filters to threads that called any person-shaped Addie tool (`lookup_person`, `get_person_memory`, `get_account`, `diagnose_signin_block`, `list_invites_for_org`, `resend_invite`, `revoke_invite`). Useful for sampling Addie's reasoning over individual people in one click instead of cycling through seven separate filters. Single-tool form still works.

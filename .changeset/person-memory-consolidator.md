---
---

`loadRelationshipContext` now returns four additional fields so Addie has a complete picture of a person at conversation start instead of stitching it from N joins: `identity` (account_linked + has_slack/has_email flags), `preferences` (contact_preference + opted_out + marketing_opt_in), `invites` (pending or expired membership invites for the email), and `recentThreads` (the last 5 threads with title/channel/last_message_at). A new admin endpoint `GET /api/admin/relationships/:personId/memory` and a minimal `/admin/relationships/:personId` page render the consolidated view ("what does Addie know about this person"). A new Addie tool `get_person_memory(query)` exposes the same data conversationally. Foundation for #3582; the prompt-assembler swap-over is PR2.

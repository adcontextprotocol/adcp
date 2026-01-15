---
---

fix: Remove RSS and email content from Editorial working group

Migration 153 incorrectly swept RSS feed articles into the Editorial working group.
RSS content should remain unassigned (working_group_id = NULL) and display
via The Latest sections through addie_knowledge.

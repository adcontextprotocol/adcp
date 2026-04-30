---
---

`formatContextForPrompt` now renders the four memory fields added in #3659 — `Account linked` flag inline in the header, plus `### Preferences`, `### Open membership invites`, `### Recent threads` sections. Empty sections are omitted; `opted_out: true` renders a "do not contact" warning. This is the consumer-side swap that makes the consolidator's new fields actually reach Addie's prompt on every conversation.

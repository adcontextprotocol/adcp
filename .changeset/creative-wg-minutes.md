---
---

feat: Show meeting minutes on working group pages and fix Google Docs permission debugging

- Added "Meeting Minutes" section to working group detail pages showing past meetings with Zoom-generated summaries
- Added `?past=true` parameter to public meetings API to support fetching past meetings
- Upgraded Google Docs API error logging from debug to warn level with actual error details from Google
- Fixed reindexDocument returning success even when indexing fails (access_denied was silently swallowed)
- Show document management UI (retry indexing, manage docs button) for site admins, not just WG members

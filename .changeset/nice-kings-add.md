---
"@conductor/florence-v11": patch
---

### Zoom Meeting Webhooks & User Timezone

**Zoom Webhook Integration:**
- Handle `meeting.started` and `meeting.ended` webhooks to update meeting status
- Handle `recording.completed` webhook to store transcripts and Zoom AI Companion summaries
- Send Slack notifications to working group channels when meetings start/end
- Fix JSON body parsing to allow webhook signature verification

**User Timezone:**
- Add timezone column to users table for scheduling preferences
- Add helper functions for timezone management (getUserTimezone, updateUserTimezone, etc.)

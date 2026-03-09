---
---

Fix Addie re-sending Link Account message to already-linked users.

Two bugs fixed:
- Auth callback now marks Link Account outreach goal as 'success' when the user completes the link flow (first-time or re-click), so the outbound planner stops targeting them.
- OutboundPlanner.isAvailable() now correctly blocks 'deferred' goals with no retry time set, preventing them from re-triggering after 7 days.

---
---

Admin content fixes (from Mary's feedback):

- **#2291** `/api/me/content` now returns the article body and tags so the Edit modal can actually populate the content field. Admins see every perspective in the list so they can edit anything (including content they didn't author, like `building-future-of-marketing`). Participation stats are still scoped to the user's own relationships.
- **#2292** `POST /api/content/propose` honors the caller's requested status. Committee leads who choose "Submit for Review" or "Save as Draft" no longer get silently auto-published. Default for leads remains "Publish Now". Non-leads cannot escalate to `published`. Added `DELETE /api/me/content/:id` so owners can delete their own drafts/pending items (published still requires admin).
- **#2294** Replaced the broken `/api/chat/completions` call with a new `POST /api/admin/content/:id/social-drafts` endpoint that generates LinkedIn + X drafts inline. Failures now surface the error instead of silently redirecting to Addie.

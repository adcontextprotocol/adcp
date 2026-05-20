---
---

fix(editorial): add needs_revisions workflow so committee leads can request revisions without losing articles from the review queue

Closes #4868. The "Request Revisions" path in the editorial review queue was silently calling the permanent rejection endpoint, setting article status to `rejected` and removing the article from `list_pending_content`. Authors received no actionable path back into the review process.

Changes:
- DB migration 488: adds `needs_revisions` to the perspectives status CHECK constraint and a separate `revision_notes` column (keeps `rejection_reason` for terminal rejection only)
- `listPendingContentForUser`: now returns both `pending_review` and `needs_revisions` items; adds `status` and `revision_notes` to the result shape
- New `requestRevisionsForUser` / `POST /api/content/:id/request-revisions`: sets status to `needs_revisions`, stores notes, keeps article visible in the reviewer queue
- New `resubmitContentForUser` / `POST /api/content/:id/resubmit`: proposer-only action that moves `needs_revisions` back to `pending_review`
- `approveContentForUser` and `rejectContentForUser` guards updated to accept `needs_revisions` as a valid starting state
- `my-content-service.ts`: `VALID_STATUSES` extended; `revision_notes` and `rejection_reason` added to SELECT and `MyContentItem`
- `member-context.ts` badge counter updated to include `needs_revisions` items
- New `request_revisions` Addie MCP tool (distinct from permanent `reject_content`); `list_pending_content` shows status and revision notes inline
- `admin-content.html`: review modal now calls `/request-revisions`; "Needs revisions" and "Rejected" statuses no longer share a label; status filter updated
- `my-content.html`: shows revision notes for `needs_revisions` items; "Resubmit for review" button for the original proposer; status filter updated

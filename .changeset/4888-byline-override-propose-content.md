---
---

feat(addie): byline override for propose_content and admin-content editor (#4888)

Adds an optional `byline` parameter to the `propose_content` Addie tool so users can post as "AgenticAdvertising.org Team" (or any org-level name) instead of their personal profile name. The `byline` surfaces as a free-text "Author byline" field in the admin-content.html edit drawer as well, populated from the saved `author_name` when opening an existing piece.

Server-side changes: `byline` added to `ProposeContentRequest`, validated at 255-char limit (matching sibling fields), used to override the hardcoded `userInfo.name` derivation in `proposeContentForUser`. The PATCH `author_name` branch is now gated to proposer/primary-author/admin (previously ungated — any co-author could rebrand someone else's post); syncs `content_authors.display_name` for the primary author row on save for consistency.

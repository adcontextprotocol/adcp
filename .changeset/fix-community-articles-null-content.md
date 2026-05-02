---
---

Fix NOT NULL violation when queueing community-shared articles from Slack. `queueCommunityArticle` was omitting `content` from its INSERT into `addie_knowledge`, but the column is `NOT NULL`. Now inserts `''` as a placeholder, matching the pattern used by other pending-fetch insert paths (RSS curator, queueResourceForIndexing). Content gets filled in once the fetcher processes the URL.

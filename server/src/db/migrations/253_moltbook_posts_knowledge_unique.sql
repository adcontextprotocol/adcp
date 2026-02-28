-- Prevent duplicate Moltbook posts for the same addie_knowledge article.
-- knowledge_id was added (migration 191) with only an index, not a unique constraint.
-- Without uniqueness, concurrent poster runs (e.g. during a crash-restart cycle or
-- multi-instance deploy) could each insert a moltbook_posts row for the same knowledge_id,
-- bypassing the dedup logic in getUnpostedArticles() and causing repeated posts.

-- Remove duplicate rows per knowledge_id.
-- Prefer the row with a real moltbook_post_id (the one that actually succeeded on Moltbook),
-- falling back to the earliest by created_at.
DELETE FROM moltbook_posts
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY knowledge_id
             ORDER BY (moltbook_post_id IS NULL), created_at ASC
           ) AS rn
    FROM moltbook_posts
    WHERE knowledge_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Add unique constraint (NULLs are exempt: rows without a knowledge_id link,
-- e.g. manually created posts, may coexist).
ALTER TABLE moltbook_posts
  ADD CONSTRAINT moltbook_posts_knowledge_id_unique UNIQUE (knowledge_id);

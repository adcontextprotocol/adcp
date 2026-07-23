-- Preserve publication history when its source perspective is deleted.
--
-- Newsletter editions, Build editions, and Moltbook posts remain useful audit
-- records after an article is removed. Their perspective links are optional,
-- so clearing the link is safer than either blocking the delete or cascading
-- into those records.

ALTER TABLE weekly_digests
  DROP CONSTRAINT IF EXISTS weekly_digests_perspective_id_fkey,
  ADD CONSTRAINT weekly_digests_perspective_id_fkey
    FOREIGN KEY (perspective_id) REFERENCES perspectives(id) ON DELETE SET NULL;

ALTER TABLE build_editions
  DROP CONSTRAINT IF EXISTS build_editions_perspective_id_fkey,
  ADD CONSTRAINT build_editions_perspective_id_fkey
    FOREIGN KEY (perspective_id) REFERENCES perspectives(id) ON DELETE SET NULL;

ALTER TABLE moltbook_posts
  DROP CONSTRAINT IF EXISTS moltbook_posts_perspective_id_fkey,
  ADD CONSTRAINT moltbook_posts_perspective_id_fkey
    FOREIGN KEY (perspective_id) REFERENCES perspectives(id) ON DELETE SET NULL;

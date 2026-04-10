-- Newsletter Cover Images
-- Store per-edition cover illustrations in the digest table so they're
-- available at draft time (before a perspective exists).

ALTER TABLE weekly_digests ADD COLUMN cover_image_data BYTEA;
ALTER TABLE weekly_digests ADD COLUMN cover_prompt_used TEXT;

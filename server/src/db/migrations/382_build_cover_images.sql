-- Newsletter Cover Images for The Build
-- Same pattern as 380_newsletter_cover_images.sql (which added these to weekly_digests).

ALTER TABLE build_editions ADD COLUMN cover_image_data BYTEA;
ALTER TABLE build_editions ADD COLUMN cover_prompt_used TEXT;

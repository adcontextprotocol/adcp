-- Add recap field to events table for post-event content (TipTap HTML)
ALTER TABLE events ADD COLUMN IF NOT EXISTS recap_html TEXT;
-- Video link for recap (YouTube, Vimeo, etc.)
ALTER TABLE events ADD COLUMN IF NOT EXISTS recap_video_url TEXT;

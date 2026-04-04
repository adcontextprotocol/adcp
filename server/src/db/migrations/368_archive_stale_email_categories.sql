-- Archive stale email categories replaced by The Prompt and The Build
-- Add is_archived flag so the admin UI can hide them while preserving
-- existing user preferences (no data loss)

ALTER TABLE email_categories ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

-- Weekly Digest → replaced by The Prompt
UPDATE email_categories SET is_archived = true, description = 'Archived — replaced by The Prompt' WHERE id = 'weekly_digest';

-- Newsletter → predates The Prompt, no longer active
UPDATE email_categories SET is_archived = true, description = 'Archived — replaced by The Prompt' WHERE id = 'newsletter';

-- Working Group Updates → consolidated into The Prompt (From the Inside) and The Build (Decisions)
UPDATE email_categories SET is_archived = true, description = 'Archived — consolidated into The Prompt and The Build' WHERE id = 'working_groups';

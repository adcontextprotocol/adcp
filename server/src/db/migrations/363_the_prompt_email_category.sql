-- Rename weekly_digest email category to the_prompt.
-- Users who opted out of weekly_digest keep their opt-out under the new name.
-- Users who opted out of working_groups (the old WG digest category) are
-- respected — WG content is now inside The Prompt, so we add an opt-out
-- for the_prompt if they had one for working_groups but not weekly_digest.

-- Step 1: Insert the new category
INSERT INTO email_categories (id, name, description, default_enabled, sort_order)
VALUES (
  'the_prompt',
  'The Prompt',
  'Addie''s weekly newsletter on agentic advertising',
  true,
  1
)
ON CONFLICT (id) DO NOTHING;

-- Step 2: Migrate existing weekly_digest opt-outs to the_prompt
INSERT INTO user_email_category_preferences (user_preference_id, category_id, enabled, updated_at)
SELECT uecp.user_preference_id, 'the_prompt', uecp.enabled, NOW()
FROM user_email_category_preferences uecp
WHERE uecp.category_id = 'weekly_digest'
ON CONFLICT (user_preference_id, category_id) DO NOTHING;

-- Step 3: Users who opted out of working_groups but had no weekly_digest pref
-- should also opt out of the_prompt (since WG content is now inside it)
INSERT INTO user_email_category_preferences (user_preference_id, category_id, enabled, updated_at)
SELECT uecp.user_preference_id, 'the_prompt', FALSE, NOW()
FROM user_email_category_preferences uecp
WHERE uecp.category_id = 'working_groups'
  AND uecp.enabled = FALSE
  AND NOT EXISTS (
    SELECT 1 FROM user_email_category_preferences existing
    WHERE existing.user_preference_id = uecp.user_preference_id
      AND existing.category_id = 'the_prompt'
  )
ON CONFLICT (user_preference_id, category_id) DO NOTHING;

-- Step 4: Update weekly_digest category description (keep for history, don't delete)
UPDATE email_categories
SET name = 'Weekly Digest (archived)',
    description = 'Archived — replaced by The Prompt'
WHERE id = 'weekly_digest';

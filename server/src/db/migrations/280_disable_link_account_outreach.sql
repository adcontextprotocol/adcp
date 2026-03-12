-- Disable the "Link Account" proactive outreach goal.
-- Account linking should be user-initiated, not pushed via DMs.
UPDATE outreach_goals
SET is_enabled = false
WHERE category = 'admin'
  AND name = 'Link Account';

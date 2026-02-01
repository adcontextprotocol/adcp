-- Add 'share' activity type for tracking Slack notifications
-- This prevents duplicate "interesting thread" notifications

ALTER TABLE moltbook_activity
DROP CONSTRAINT moltbook_activity_activity_type_check;

ALTER TABLE moltbook_activity
ADD CONSTRAINT moltbook_activity_activity_type_check
CHECK (activity_type IN ('post', 'comment', 'upvote', 'downvote', 'share'));

-- Migration: 196_add_follow_activity_type.sql
-- Add 'follow' to moltbook_activity allowed types

ALTER TABLE moltbook_activity
DROP CONSTRAINT moltbook_activity_activity_type_check;

ALTER TABLE moltbook_activity
ADD CONSTRAINT moltbook_activity_activity_type_check
CHECK (activity_type IN ('post', 'comment', 'upvote', 'downvote', 'share', 'follow'));

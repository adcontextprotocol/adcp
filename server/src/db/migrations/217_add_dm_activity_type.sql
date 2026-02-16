-- Migration: 217_add_dm_activity_type.sql
-- Add 'dm' to the moltbook_activity activity_type check constraint

ALTER TABLE moltbook_activity
DROP CONSTRAINT IF EXISTS moltbook_activity_activity_type_check;

ALTER TABLE moltbook_activity
ADD CONSTRAINT moltbook_activity_activity_type_check
CHECK (activity_type IN ('post', 'comment', 'upvote', 'downvote', 'share', 'follow', 'dm'));

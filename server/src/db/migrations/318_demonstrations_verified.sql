-- Add demonstrations_verified to teaching_checkpoints
-- Tracks which exercise success_criteria a learner has demonstrably met.
-- Ensures every learner is assessed on the same core competencies per module.

ALTER TABLE teaching_checkpoints
  ADD COLUMN IF NOT EXISTS demonstrations_verified TEXT[] DEFAULT '{}';

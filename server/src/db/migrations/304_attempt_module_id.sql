-- Add module_id to certification_attempts so completion can find the correct
-- capstone module (all S-track modules are format 'capstone', so the previous
-- approach of find-first-capstone-in-track returned S1 for every S-track exam).

ALTER TABLE certification_attempts
  ADD COLUMN IF NOT EXISTS module_id VARCHAR(10) REFERENCES certification_modules(id);

-- Backfill existing attempts by correlating attempt start time with learner
-- progress. Pick the capstone module whose progress started closest to (but
-- before) the attempt.  For tracks with a single capstone this is unambiguous.
UPDATE certification_attempts ca
SET module_id = (
  SELECT cm.id
  FROM certification_modules cm
  JOIN learner_progress lp ON lp.module_id = cm.id AND lp.workos_user_id = ca.workos_user_id
  WHERE cm.track_id = ca.track_id AND cm.format = 'capstone'
    AND lp.started_at <= ca.started_at + INTERVAL '1 hour'
  ORDER BY lp.started_at DESC
  LIMIT 1
)
WHERE ca.module_id IS NULL;

-- For any remaining NULLs (edge cases), fall back to first capstone in track
UPDATE certification_attempts ca
SET module_id = (
  SELECT cm.id
  FROM certification_modules cm
  WHERE cm.track_id = ca.track_id AND cm.format = 'capstone'
  ORDER BY cm.sort_order
  LIMIT 1
)
WHERE ca.module_id IS NULL;

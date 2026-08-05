-- Governance-context `sub` is an opaque governed-action binding in the latest
-- experimental profile, not a plan identifier. Keep the seeded S6 exercise in
-- sync without rewriting the historical seed migration.
UPDATE certification_modules
SET lesson_plan = replace(
  lesson_plan::text,
  'aud, sub equals plan_id, phase, jti, exp',
  'aud, opaque action-binding sub (not plan_id), phase, jti, exp'
)::jsonb
WHERE id = 'S6';

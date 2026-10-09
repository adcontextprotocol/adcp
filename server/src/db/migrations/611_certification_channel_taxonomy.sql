-- Canonical authority: static/schemas/source/enums/channels.json (20 values).
-- Correct stored copy without rewriting historical seed migrations or changing
-- learner progress. The A1 enumeration omitted olv (online video).
UPDATE certification_modules
SET lesson_plan = replace(
      replace(lesson_plan::text, '19 channels', '20 channels'),
      'display, social, search', 'display, online video (OLV), social, search'
    )::jsonb,
    description = replace(description, '19 channels', '20 channels')
WHERE id IN ('A1', 'A3', 'S2');

-- Fix C2 module terminology: "Brand Standards Protocol" is not an AdCP term.
-- The correct terms are: brand.json (identity), content standards (compliance checking),
-- campaign governance (transaction validation).

-- Fix description
UPDATE certification_modules
SET description = 'The brand.json identity protocol, content standards for automated compliance checking, campaign governance (check_governance, sync_plans, report_plan_outcome), and how brand agents enforce guidelines across automated buying.'
WHERE id = 'C2';

-- Fix key_concepts teaching notes
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN elem->>'topic' = 'Brand compliance'
        THEN jsonb_set(
          elem,
          '{teaching_notes}',
          to_jsonb(replace(elem->>'teaching_notes', 'brand standards protocol', 'content standards'))
        )
        ELSE elem
      END
    )
    FROM jsonb_array_elements(lesson_plan->'key_concepts') AS elem
  )
)
WHERE id = 'C2';

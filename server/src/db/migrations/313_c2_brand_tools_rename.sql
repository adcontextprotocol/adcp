-- Rename sandbox_* brand tools to standard AdCP tool names in C2 exercise definitions.
-- These tools now route through adcp-tools.ts to the training agent, like all other AdCP tools.
-- One-way: the sandbox_* tool names no longer exist in the codebase.
UPDATE certification_modules
SET exercise_definitions = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(
        exercise_definitions::text,
        'sandbox_get_brand_identity', 'get_brand_identity'
      ),
      'sandbox_get_rights', 'get_rights'
    ),
    'sandbox_acquire_rights', 'acquire_rights'
  ),
  'sandbox_update_rights', 'update_rights'
)::jsonb
WHERE id = 'C2';

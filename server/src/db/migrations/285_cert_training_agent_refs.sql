-- Replace @cptestagent references with "the sandbox training agent"
-- in certification module descriptions and lesson plans.
-- The training agent is now embedded in the server and doesn't use the
-- old external cptestagent endpoint.

UPDATE certification_modules
SET description = replace(description, '@cptestagent', 'the sandbox training agent')
WHERE description LIKE '%@cptestagent%';

UPDATE certification_modules
SET lesson_plan = replace(lesson_plan::text, '@cptestagent', 'the sandbox training agent')::jsonb
WHERE lesson_plan::text LIKE '%@cptestagent%';

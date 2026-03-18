-- Update build project Phase 2 teaching notes to coach non-coders through the debug loop.
-- The BUILD_PROJECT_METHODOLOGY and system prompt in prompts.ts were updated alongside this.
-- key_concepts[1] is "Phase 2: Build (~5 min)" for all build project modules (B4, C4, D4).

-- B4: Publisher build project
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts,1,teaching_notes}',
  '"The learner goes to their coding assistant and builds the agent. They should use the adcp client library (pip install adcp or npm). This is the fast part — tell them to come back when it''s running. If they hit issues, help them refine their prompt, don''t debug code. When the build fails: acknowledge the error category in one sentence (without naming the specific package, file, or line), tell the learner to copy the error and paste it into their coding assistant with ''I got this error when I tried to run it'', and reassure them that 2-3 error cycles is normal. Do not give them the fix — even if it''s trivial. The debug loop (error, paste to assistant, iterate) is the most valuable skill in this module. If after 3 rounds on the same error the coding assistant hasn''t resolved it, suggest the learner tell their coding assistant to start fresh from the specification."'
)
WHERE id = 'B4'
  AND lesson_plan #>> '{key_concepts,1,topic}' = 'Phase 2: Build (~5 min)';

-- C4: Buyer build project
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts,1,teaching_notes}',
  '"The learner builds the buyer agent with their coding assistant and the adcp client library. The agent should connect to @cptestagent (or any sandbox agent) for testing. Tell them to come back when it''s running and has executed at least one buy. When the build fails: acknowledge the error category in one sentence (without naming the specific package, file, or line), tell the learner to copy the error and paste it into their coding assistant with ''I got this error when I tried to run it'', and reassure them that 2-3 error cycles is normal. Do not give them the fix — even if it''s trivial. The debug loop (error, paste to assistant, iterate) is the most valuable skill in this module. If after 3 rounds on the same error the coding assistant hasn''t resolved it, suggest the learner tell their coding assistant to start fresh from the specification."'
)
WHERE id = 'C4'
  AND lesson_plan #>> '{key_concepts,1,topic}' = 'Phase 2: Build (~5 min)';

-- D4: Platform build project
UPDATE certification_modules
SET lesson_plan = jsonb_set(
  lesson_plan,
  '{key_concepts,1,teaching_notes}',
  '"The learner builds with their coding assistant and adcp client library. get_adcp_capabilities is non-negotiable — it''s how other agents discover the platform. Tell them to come back when it''s running and responding to capability queries. When the build fails: acknowledge the error category in one sentence (without naming the specific package, file, or line), tell the learner to copy the error and paste it into their coding assistant with ''I got this error when I tried to run it'', and reassure them that 2-3 error cycles is normal. Do not give them the fix — even if it''s trivial. The debug loop (error, paste to assistant, iterate) is the most valuable skill in this module. If after 3 rounds on the same error the coding assistant hasn''t resolved it, suggest the learner tell their coding assistant to start fresh from the specification."'
)
WHERE id = 'D4'
  AND lesson_plan #>> '{key_concepts,1,topic}' = 'Phase 2: Build (~5 min)';

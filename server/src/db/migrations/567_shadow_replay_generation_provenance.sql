-- Bind every replay generation to immutable requested/returned model metadata.
-- Existing rows predate exact code-version capture and are labelled explicitly.

ALTER TABLE addie_shadow_replay_generations
  ADD COLUMN requested_provider VARCHAR(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN addie_code_version VARCHAR(64) NOT NULL DEFAULT 'legacy-unrecorded',
  ADD COLUMN returned_provider VARCHAR(16),
  ADD COLUMN returned_model VARCHAR(160);

UPDATE addie_shadow_replay_generations
SET requested_provider = CASE
      WHEN model LIKE 'claude-%' THEN 'anthropic'
      WHEN model ~ '^(gpt-|o[0-9])' THEN 'openai'
      WHEN model LIKE 'gemini-%' THEN 'google'
      ELSE 'unknown'
    END,
    addie_code_version = 'legacy-unrecorded';

ALTER TABLE addie_shadow_replay_generations
  ADD CONSTRAINT shadow_replay_generation_requested_provider_valid
    CHECK (requested_provider IN ('anthropic', 'openai', 'google', 'unknown')),
  ADD CONSTRAINT shadow_replay_generation_code_version_valid
    CHECK (addie_code_version ~ '^[a-zA-Z0-9._:-]{1,64}$'),
  ADD CONSTRAINT shadow_replay_generation_returned_provider_valid
    CHECK (returned_provider IS NULL OR returned_provider IN ('anthropic', 'openai', 'google')),
  ADD CONSTRAINT shadow_replay_generation_returned_model_valid
    CHECK (returned_model IS NULL OR length(returned_model) > 0),
  ADD CONSTRAINT shadow_replay_generation_returned_model_all_or_none
    CHECK ((returned_provider IS NULL) = (returned_model IS NULL));

COMMENT ON COLUMN addie_shadow_replay_generations.requested_provider IS
  'Provider atomically claimed before the first replay SDK dispatch';
COMMENT ON COLUMN addie_shadow_replay_generations.model IS
  'Exact model atomically claimed before the first replay SDK dispatch';
COMMENT ON COLUMN addie_shadow_replay_generations.addie_code_version IS
  'Addie code/config version active when the replay generation was claimed';
COMMENT ON COLUMN addie_shadow_replay_generations.returned_provider IS
  'Provider identity returned by the SDK, null when no provider response exists';
COMMENT ON COLUMN addie_shadow_replay_generations.returned_model IS
  'Canonicalized model identity returned by the SDK, null with returned_provider';

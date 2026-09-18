-- Surface-specific assignment provenance and content-free terminal/delivery
-- outcomes for the Gemini Direct web experiment.
ALTER TABLE addie_chat_experiment_turns
  ADD COLUMN surface TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN identity_cohort TEXT NOT NULL DEFAULT 'authenticated',
  ADD COLUMN assignment_unit TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN assignment_version TEXT NOT NULL DEFAULT 'authenticated_web_v1',
  ADD COLUMN delivery_outcome TEXT,
  ADD COLUMN iterations INTEGER,
  ADD COLUMN progress_extensions INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN final_answer_opportunities INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN final_answer_rejected_calls INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN output_truncation_source TEXT,
  ADD COLUMN output_truncation_provider_reason TEXT,
  ADD COLUMN output_truncation_original_length INTEGER,
  ADD COLUMN output_truncation_delivered_length INTEGER;

ALTER TABLE addie_chat_experiment_turns
  ADD CONSTRAINT addie_chat_experiment_turns_surface_check
    CHECK (surface IN ('web')),
  ADD CONSTRAINT addie_chat_experiment_turns_identity_cohort_check
    CHECK (identity_cohort IN ('authenticated', 'anonymous', 'auth_transition')),
  ADD CONSTRAINT addie_chat_experiment_turns_assignment_unit_check
    CHECK (assignment_unit IN ('user', 'anonymous_owner', 'manual_choice')),
  ADD CONSTRAINT addie_chat_experiment_turns_delivery_outcome_check
    CHECK (delivery_outcome IN ('completed', 'interrupted')),
  ADD CONSTRAINT addie_chat_experiment_turns_iterations_check
    CHECK (iterations IS NULL OR iterations >= 0),
  ADD CONSTRAINT addie_chat_experiment_turns_progress_extensions_check
    CHECK (progress_extensions >= 0),
  ADD CONSTRAINT addie_chat_experiment_turns_final_answer_opportunities_check
    CHECK (final_answer_opportunities >= 0),
  ADD CONSTRAINT addie_chat_experiment_turns_final_answer_rejected_calls_check
    CHECK (final_answer_rejected_calls >= 0),
  ADD CONSTRAINT addie_chat_experiment_turns_output_truncation_source_check
    CHECK (output_truncation_source IN ('provider_output_limit', 'local_character_limit'));

CREATE INDEX idx_addie_chat_experiment_turns_surface_started
  ON addie_chat_experiment_turns (experiment, surface, identity_cohort, started_at);

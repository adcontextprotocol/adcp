-- Keep user-selected comparisons distinct from randomized assignment. The
-- original choice is also stored on the user turn so retries cannot change it.
ALTER TABLE addie_thread_messages
  ADD COLUMN model_preference TEXT
    CHECK (model_preference IN ('default', 'gemini', 'sonnet'));

ALTER TABLE addie_chat_experiment_turns
  DROP CONSTRAINT addie_chat_experiment_turns_cohort_check;
ALTER TABLE addie_chat_experiment_turns
  ADD CONSTRAINT addie_chat_experiment_turns_cohort_check
    CHECK (cohort IN ('staff', 'eligible', 'existing', 'manual'));

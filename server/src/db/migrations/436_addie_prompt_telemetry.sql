-- Telemetry for Addie's suggested-prompt rules engine.
--
-- Without per-user-per-rule history, every activation rule fires
-- indefinitely until the underlying signal flips. An owner who
-- intentionally doesn't list their company in the directory still sees
-- "List my company in the directory" forever. The rules engine reads
-- this table to suppress prompts that have been shown enough times
-- without action.
--
-- One row per (user, rule). Updated on every render that picks the
-- rule. Suppression is computed in the application layer based on
-- shown_count and last_shown_at; suppressed_until is the cached
-- decision so the evaluator stays fast.

CREATE TABLE IF NOT EXISTS addie_prompt_telemetry (
  workos_user_id   VARCHAR(255) NOT NULL,
  rule_id          VARCHAR(255) NOT NULL,
  shown_count      INTEGER      NOT NULL DEFAULT 0,
  last_shown_at    TIMESTAMPTZ,
  suppressed_until TIMESTAMPTZ,
  PRIMARY KEY (workos_user_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_addie_prompt_telemetry_user
  ON addie_prompt_telemetry (workos_user_id);

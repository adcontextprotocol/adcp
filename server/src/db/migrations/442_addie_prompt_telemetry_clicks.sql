-- Click telemetry for Addie's suggested-prompts.
--
-- Stage 1 of #3282 added shown_count + last_shown_at + suppressed_until
-- so the rules engine could suppress fatiguing prompts. We've been flying
-- blind on whether prompts actually convert: nothing recorded a click.
--
-- We can't intercept clicks at the surface level (Slack Assistant prompts
-- just submit a message; the bot can't tell click vs typed). Instead we
-- detect clicks heuristically: when an incoming user message exactly
-- matches a known rule's prompt string, record a click on that rule.
-- ~95% accurate (false positives only when a user copy-pastes the same
-- text), good enough for relative ranking.

ALTER TABLE addie_prompt_telemetry
  ADD COLUMN IF NOT EXISTS clicked_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMPTZ;

COMMENT ON COLUMN addie_prompt_telemetry.clicked_count IS
  'Number of times the user has sent a message matching this rule''s prompt text. Heuristic: exact-string match against the rule registry, recorded fire-and-forget at message receipt.';

COMMENT ON COLUMN addie_prompt_telemetry.last_clicked_at IS
  'Timestamp of the most recent matched click. NULL means never clicked.';

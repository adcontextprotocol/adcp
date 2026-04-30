-- Tag messages by input source so the insights pipeline can exclude CTA-chip
-- clicks from theme analysis without relying on a fragile string allowlist
-- (stopgap in conversation-insights-builder.ts, Refs #3408/#3455).
--
-- NULL = row predates tagging (2026-04-28). The insights filter uses
-- IS DISTINCT FROM 'cta_chip' which keeps NULLs in the sample — correct
-- behavior; old untagged rows are treated as organic conversations.
-- No backfill needed.

ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS message_source TEXT
  CHECK (message_source IN ('typed', 'cta_chip', 'voice', 'paste', 'email', 'unknown'));

COMMENT ON COLUMN addie_thread_messages.message_source IS
  'How the user initiated this message. typed=keyboard input, cta_chip=welcome/suggested-prompt button click, voice=Tavus voice session, paste=clipboard paste (reserved), email=inbound email reply, unknown=automated/system paths. NULL on rows predating 2026-04-28.';

-- Tag addie_thread_messages rows with the input modality that produced them.
-- 'typed'    — user typed the message manually
-- 'cta_chip' — user clicked a suggested-prompt button (home chip, welcome card, module start)
-- 'voice'    — voice input (future)
-- 'paste'    — paste-detected (future)
-- 'unknown'  — pre-migration rows or modality not determined at write-time
ALTER TABLE addie_thread_messages
  ADD COLUMN IF NOT EXISTS message_source TEXT
  CHECK (message_source IN ('typed', 'cta_chip', 'voice', 'paste', 'unknown'));

-- Pre-migration rows remain NULL; the insights-builder filter uses
-- IS DISTINCT FROM 'cta_chip' so NULLs are treated as organic messages.

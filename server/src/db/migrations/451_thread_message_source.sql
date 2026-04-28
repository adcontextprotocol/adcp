-- Add message_source to addie_thread_messages.
-- Tracks how the message was initiated: 'typed' (user typed it), 'cta_chip'
-- (user clicked a suggested-prompt chip), 'voice', 'paste', or 'unknown'
-- (legacy rows and paths not yet classified).
--
-- NOT NULL DEFAULT 'unknown' is metadata-only in Postgres 11+ — no table
-- rewrite. Existing rows get 'unknown'; new rows supply the source at write-time.

ALTER TABLE addie_thread_messages
  ADD COLUMN message_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (message_source IN ('typed', 'cta_chip', 'voice', 'paste', 'unknown'));

COMMENT ON COLUMN addie_thread_messages.message_source IS
  'How the message was initiated. typed=user typed it; cta_chip=suggested-prompt chip click; voice=voice input; paste=detected paste; unknown=legacy/unclassified.';

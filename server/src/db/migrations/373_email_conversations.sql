-- Email conversations: allow Addie to have threaded email conversations
-- by linking email Message-IDs to thread messages

ALTER TABLE addie_thread_messages ADD COLUMN IF NOT EXISTS email_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_thread_messages_email_mid
  ON addie_thread_messages(email_message_id)
  WHERE email_message_id IS NOT NULL;

-- Track the email channel on threads
ALTER TABLE addie_threads ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web';

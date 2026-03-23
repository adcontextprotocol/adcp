-- Add binary avatar storage so users can upload profile photos directly
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT
  CHECK (avatar_mime_type IN ('image/jpeg', 'image/png'));

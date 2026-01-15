-- Add timezone column to users table
-- This stores the user's preferred timezone for scheduling meetings and notifications
-- Standard IANA timezone format (e.g., 'America/New_York', 'Europe/London')

ALTER TABLE users
ADD COLUMN IF NOT EXISTS timezone VARCHAR(100);

-- Index for finding users by timezone (useful for scheduling)
CREATE INDEX IF NOT EXISTS idx_users_timezone ON users(timezone) WHERE timezone IS NOT NULL;

COMMENT ON COLUMN users.timezone IS 'User preferred timezone in IANA format (e.g., America/New_York)';

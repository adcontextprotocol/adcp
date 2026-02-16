-- Migration: 212_github_username.sql
-- Add github_username to users, seed GitHub-related badges.

ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_username) WHERE github_username IS NOT NULL;

COMMENT ON COLUMN users.github_username IS 'GitHub username for linking contributions to AdCP repos';

-- New badges for code contributors
INSERT INTO badges (id, name, description, icon, category) VALUES
  ('code_contributor', 'Code contributor', 'Merged a pull request to an AdCP repository', '💻', 'achievement'),
  ('spec_author', 'Spec author', 'Contributed to the AdCP protocol specification', '📜', 'achievement'),
  ('reviewer', 'Reviewer', 'Reviewed 5+ pull requests', '🔍', 'achievement'),
  ('first_pr', 'First pull request', 'Merged their first pull request', '🏆', 'achievement')
ON CONFLICT (id) DO NOTHING;

-- Portraits belong to users, not member profiles.
-- Add user_id column, backfill from existing data, make member_profile_id nullable.

-- 1. Add user_id column
ALTER TABLE member_portraits ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(workos_user_id);

-- 2. Add portrait_id to users table (active portrait pointer, like member_profiles has)
ALTER TABLE users ADD COLUMN IF NOT EXISTS portrait_id UUID REFERENCES member_portraits(id);

-- 3. Backfill user_id on existing portraits from org membership
-- For each portrait, find the user whose avatar_url matches (set by migration 324),
-- or fall back to the first user in the org.
UPDATE member_portraits mp
SET user_id = sub.workos_user_id
FROM (
  SELECT DISTINCT ON (p.id)
    p.id AS portrait_id,
    om.workos_user_id
  FROM member_portraits p
  JOIN member_profiles prof ON prof.id = p.member_profile_id
  JOIN organization_memberships om ON om.workos_organization_id = prof.workos_organization_id
  LEFT JOIN users u ON u.workos_user_id = om.workos_user_id
  ORDER BY p.id,
    -- Prefer user whose avatar already points to this portrait
    CASE WHEN u.avatar_url = '/api/portraits/' || p.id::text || '.png' THEN 0 ELSE 1 END,
    om.created_at ASC
) sub
WHERE mp.id = sub.portrait_id
  AND mp.user_id IS NULL;

-- 4. Backfill users.portrait_id from member_profiles.portrait_id
UPDATE users u
SET portrait_id = mp.portrait_id
FROM organization_memberships om
JOIN member_profiles mp ON mp.workos_organization_id = om.workos_organization_id
WHERE u.workos_user_id = om.workos_user_id
  AND mp.portrait_id IS NOT NULL
  AND u.portrait_id IS NULL;

-- 5. Make member_profile_id nullable (portraits no longer require a member profile)
ALTER TABLE member_portraits ALTER COLUMN member_profile_id DROP NOT NULL;

-- 6. Index on user_id
CREATE INDEX IF NOT EXISTS idx_member_portraits_user_id ON member_portraits(user_id);

-- 7. Update content_with_authors view to resolve portraits from users table
DROP VIEW IF EXISTS content_with_authors;
CREATE VIEW content_with_authors AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'user_id', ca.user_id,
        'display_name', ca.display_name,
        'display_title', ca.display_title,
        'display_order', ca.display_order,
        'portrait_id', u.portrait_id::text
      ) ORDER BY ca.display_order
    )
    FROM content_authors ca
    LEFT JOIN users u ON u.workos_user_id = ca.user_id
    WHERE ca.perspective_id = p.id),
    '[]'::json
  ) AS authors_json
FROM perspectives p;

COMMENT ON VIEW content_with_authors IS 'Perspectives with aggregated authors including portrait IDs';

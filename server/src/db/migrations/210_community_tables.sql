-- Migration: 209_community_tables.sql
-- Community platform: extend users with profile fields, add connections,
-- points, badges tables. Backfill individual member profiles into users.

-- =====================================================
-- EXTEND USERS TABLE WITH COMMUNITY PROFILE FIELDS
-- =====================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS slug VARCHAR(100) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS headline VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expertise TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS open_to_coffee_chat BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS open_to_intros BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_slug ON users(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_public ON users(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_users_expertise ON users USING gin(expertise);
CREATE INDEX IF NOT EXISTS idx_users_coffee_chat ON users(open_to_coffee_chat) WHERE open_to_coffee_chat = true;

-- =====================================================
-- BACKFILL FROM INDIVIDUAL MEMBER PROFILES
-- =====================================================
-- For users whose primary org is_personal = true and has a member_profile,
-- copy profile data into the user record.

UPDATE users u
SET
  bio = mp.description,
  headline = mp.tagline,
  avatar_url = mp.logo_url,
  linkedin_url = mp.linkedin_url,
  twitter_url = mp.twitter_url,
  is_public = mp.is_public,
  updated_at = NOW()
FROM member_profiles mp
JOIN organizations o ON o.workos_organization_id = mp.workos_organization_id
WHERE o.workos_organization_id = u.primary_organization_id
  AND o.is_personal = true
  AND (u.bio IS NULL OR u.bio = '');

-- Generate slugs for all users who don't have one yet.
-- Uses first_name-last_name, with numeric suffix for duplicates.
DO $$
DECLARE
  r RECORD;
  base_slug VARCHAR(100);
  candidate_slug VARCHAR(100);
  counter INTEGER;
BEGIN
  FOR r IN
    SELECT workos_user_id, first_name, last_name
    FROM users
    WHERE slug IS NULL
      AND first_name IS NOT NULL
      AND last_name IS NOT NULL
    ORDER BY created_at
  LOOP
    -- Generate base slug from name
    base_slug := lower(
      regexp_replace(
        regexp_replace(
          trim(r.first_name || '-' || r.last_name),
          '[^a-zA-Z0-9-]', '-', 'g'
        ),
        '-+', '-', 'g'
      )
    );
    base_slug := trim(both '-' from base_slug);

    -- Skip if empty
    IF base_slug = '' OR base_slug IS NULL THEN
      CONTINUE;
    END IF;

    -- Truncate to fit within limit
    base_slug := left(base_slug, 90);

    -- Find unique slug
    candidate_slug := base_slug;
    counter := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE slug = candidate_slug) LOOP
      counter := counter + 1;
      candidate_slug := base_slug || '-' || counter;
    END LOOP;

    UPDATE users SET slug = candidate_slug, updated_at = NOW()
    WHERE workos_user_id = r.workos_user_id;
  END LOOP;
END $$;

-- =====================================================
-- CONNECTIONS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id),
  recipient_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE(requester_user_id, recipient_user_id),
  CHECK (requester_user_id != recipient_user_id)
);

CREATE INDEX IF NOT EXISTS idx_connections_requester ON connections(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_connections_recipient ON connections(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);

COMMENT ON TABLE connections IS 'Peer-to-peer connections between community members';

-- =====================================================
-- COMMUNITY POINTS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS community_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id),
  action VARCHAR(50) NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  reference_id TEXT,
  reference_type VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_points_user ON community_points(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_community_points_action ON community_points(action);

COMMENT ON TABLE community_points IS 'Append-only activity log for community engagement points';

-- =====================================================
-- BADGES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS badges (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(10),
  category VARCHAR(20) DEFAULT 'achievement'
);

CREATE TABLE IF NOT EXISTS user_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id VARCHAR(255) NOT NULL REFERENCES users(workos_user_id),
  badge_id VARCHAR(50) NOT NULL REFERENCES badges(id),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workos_user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(workos_user_id);

COMMENT ON TABLE badges IS 'Badge definitions for community achievements';
COMMENT ON TABLE user_badges IS 'Badges awarded to individual users';

-- =====================================================
-- SEED BADGE DATA
-- =====================================================

INSERT INTO badges (id, name, description, icon, category) VALUES
  ('profile_complete', 'Profile complete', 'Completed your full community profile', '✨', 'achievement'),
  ('connector', 'Connector', 'Made 10+ connections in the community', '🤝', 'achievement'),
  ('networker', 'Networker', 'Made 25+ connections in the community', '🌐', 'achievement'),
  ('event_regular', 'Event regular', 'Attended 3+ community events', '📅', 'achievement'),
  ('contributor', 'Contributor', 'Published content or a case study', '📝', 'achievement'),
  ('working_group_member', 'Working group member', 'Joined a working group', '👥', 'achievement'),
  ('speaker', 'Speaker', 'Presented at a community event', '🎤', 'achievement')
ON CONFLICT (id) DO NOTHING;

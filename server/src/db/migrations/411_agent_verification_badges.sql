-- Agent verification badges: tracks which agents have earned AAO Verified status.
-- Badge is earned when ALL applicable storyboards pass and the agent has an active membership.

CREATE TABLE IF NOT EXISTS agent_verification_badges (
  agent_url               TEXT NOT NULL,
  role                    TEXT NOT NULL,
  verified_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_protocol_version TEXT,
  verified_specialisms    TEXT[] NOT NULL DEFAULT '{}',

  -- JWT token issued by AAO for decentralized verification
  verification_token      TEXT,
  token_expires_at        TIMESTAMPTZ,

  -- Membership that earned the badge
  membership_org_id       TEXT,

  -- Status tracking
  status                  TEXT NOT NULL DEFAULT 'active',
  revoked_at              TIMESTAMPTZ,
  revocation_reason       TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (agent_url, role),

  -- Badge roles correspond to AdCP domains (see static/schemas/source/enums/adcp-domain.json)
  CONSTRAINT valid_badge_role CHECK (
    role IN ('media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence')
  ),
  CONSTRAINT valid_badge_status CHECK (
    status IN ('active', 'degraded', 'revoked')
  )
);

CREATE INDEX IF NOT EXISTS idx_verification_badges_status
  ON agent_verification_badges(status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_verification_badges_role
  ON agent_verification_badges(role, status);

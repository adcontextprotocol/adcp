-- Member Profiles Table
-- Stores public-facing member profile data linked to organizations
CREATE TABLE IF NOT EXISTS member_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to organization
  workos_organization_id VARCHAR(255) NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Display identity
  display_name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  tagline VARCHAR(500),
  description TEXT,

  -- Branding
  logo_url TEXT,
  logo_light_url TEXT,  -- For light backgrounds
  logo_dark_url TEXT,   -- For dark backgrounds
  brand_color VARCHAR(7),  -- Hex color e.g. #10b981

  -- Contact information
  contact_email VARCHAR(255),
  contact_website TEXT,
  contact_phone VARCHAR(50),

  -- Social links
  linkedin_url TEXT,
  twitter_url TEXT,

  -- Service offerings (what they provide)
  offerings TEXT[] DEFAULT ARRAY[]::TEXT[],  -- buyer_agent, sales_agent, creative_agent, signals_agent, consulting, other

  -- Searchable metadata
  metadata JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Visibility & Status
  is_public BOOLEAN DEFAULT FALSE,  -- Show in member directory
  show_in_carousel BOOLEAN DEFAULT FALSE,  -- Show logo in homepage carousel
  featured BOOLEAN DEFAULT FALSE,  -- Featured members shown first

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_member_profiles_org ON member_profiles(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_member_profiles_slug ON member_profiles(slug);
CREATE INDEX IF NOT EXISTS idx_member_profiles_public ON member_profiles(is_public) WHERE is_public = TRUE;
CREATE INDEX IF NOT EXISTS idx_member_profiles_carousel ON member_profiles(show_in_carousel) WHERE show_in_carousel = TRUE;
CREATE INDEX IF NOT EXISTS idx_member_profiles_offerings ON member_profiles USING GIN(offerings);
CREATE INDEX IF NOT EXISTS idx_member_profiles_tags ON member_profiles USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_member_profiles_metadata ON member_profiles USING GIN(metadata);

-- Trigger for updated_at
CREATE TRIGGER update_member_profiles_updated_at
  BEFORE UPDATE ON member_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Unique constraint: one profile per organization
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_profiles_unique_org
  ON member_profiles(workos_organization_id);

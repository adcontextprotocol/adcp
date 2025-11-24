-- Registry Entries Table
-- Stores all registry entries (agents, partners)
CREATE TABLE IF NOT EXISTS registry_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type VARCHAR(50) NOT NULL CHECK (entry_type IN ('agent', 'partner')),

  -- Identity
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  url TEXT NOT NULL,

  -- Card presentation (future)
  card_manifest_url TEXT,
  card_format_id JSONB,

  -- Metadata (searchable/filterable)
  metadata JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Contact info
  contact_name VARCHAR(255),
  contact_email VARCHAR(255),
  contact_website TEXT,

  -- Status
  approval_status VARCHAR(20) DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by VARCHAR(255),
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE,

  -- Indexes
  CONSTRAINT unique_slug UNIQUE (slug)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_registry_entry_type ON registry_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_registry_active ON registry_entries(active);
CREATE INDEX IF NOT EXISTS idx_registry_approval_status ON registry_entries(approval_status);
CREATE INDEX IF NOT EXISTS idx_registry_tags ON registry_entries USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_registry_metadata ON registry_entries USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_registry_created_at ON registry_entries(created_at DESC);

-- Audit trail table (for future use)
CREATE TABLE IF NOT EXISTS registry_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID REFERENCES registry_entries(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  actor VARCHAR(255),
  changes JSONB,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entry_id ON registry_audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON registry_audit_log(created_at DESC);

-- Updated timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_registry_entries_updated_at
  BEFORE UPDATE ON registry_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

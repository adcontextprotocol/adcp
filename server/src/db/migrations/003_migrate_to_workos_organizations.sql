-- Migration: Use WorkOS Organizations instead of custom company management
-- Drop redundant tables since WorkOS handles users, memberships, and roles

-- Drop company_users table (WorkOS organization memberships replace this)
DROP TABLE IF EXISTS company_users CASCADE;

-- Drop companies table and recreate with minimal fields
DROP TABLE IF EXISTS companies CASCADE;

-- Organizations Table
-- Minimal table to link WorkOS organizations with billing/agreement data
CREATE TABLE IF NOT EXISTS organizations (
  -- WorkOS organization ID is the primary key
  workos_organization_id VARCHAR(255) PRIMARY KEY,

  -- Cached organization name for display (synced from WorkOS)
  name VARCHAR(255) NOT NULL,

  -- Billing integration (Stripe)
  stripe_customer_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50), -- active, past_due, canceled, trialing, incomplete
  subscription_tier VARCHAR(50), -- basic, professional, enterprise
  trial_end_date TIMESTAMP WITH TIME ZONE,

  -- Agreement tracking
  agreement_signed_at TIMESTAMP WITH TIME ZONE,
  agreement_version VARCHAR(50),

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Update registry_entries to reference WorkOS organization ID
ALTER TABLE registry_entries
  DROP COLUMN IF EXISTS company_id,
  ADD COLUMN IF NOT EXISTS workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id) ON DELETE CASCADE;

-- Update audit log to use WorkOS organization ID and user ID
ALTER TABLE registry_audit_log
  DROP COLUMN IF EXISTS company_id,
  ADD COLUMN IF NOT EXISTS workos_organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id),
  ADD COLUMN IF NOT EXISTS action VARCHAR(100),
  ADD COLUMN IF NOT EXISTS resource_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS details JSONB;

-- Rename user_id column to workos_user_id if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'registry_audit_log'
    AND column_name = 'user_id'
  ) THEN
    ALTER TABLE registry_audit_log RENAME COLUMN user_id TO workos_user_id;
  ELSE
    -- If workos_user_id doesn't exist yet, create it
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'registry_audit_log'
      AND column_name = 'workos_user_id'
    ) THEN
      ALTER TABLE registry_audit_log ADD COLUMN workos_user_id VARCHAR(255);
    END IF;
  END IF;
END $$;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_organizations_stripe_customer ON organizations(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_organizations_subscription_status ON organizations(subscription_status);

CREATE INDEX IF NOT EXISTS idx_registry_organization ON registry_entries(workos_organization_id);

CREATE INDEX IF NOT EXISTS idx_audit_organization ON registry_audit_log(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON registry_audit_log(workos_user_id);

-- Updated timestamp trigger for organizations (only if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_organizations_updated_at'
  ) THEN
    CREATE TRIGGER update_organizations_updated_at
      BEFORE UPDATE ON organizations
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Note: Agreements table remains unchanged since it's global, not per-organization

-- Companies Table
-- Stores companies that can manage registry entries
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255), -- For email-based auto-join (e.g., 'acme.com')

  -- Billing integration
  stripe_customer_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50), -- active, past_due, canceled, trialing, incomplete
  subscription_tier VARCHAR(50), -- basic, professional, enterprise

  -- Agreement tracking
  agreement_signed_at TIMESTAMP WITH TIME ZONE,
  agreement_version VARCHAR(50),

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Company Users Table
-- Maps users to companies with role-based access
CREATE TABLE IF NOT EXISTS company_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- User identity (from WorkOS)
  user_id VARCHAR(255) NOT NULL, -- WorkOS user ID
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'admin', 'member')),

  -- Audit
  invited_by UUID REFERENCES company_users(id),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraint: one user can only have one role per company
  CONSTRAINT unique_company_user UNIQUE(company_id, user_id)
);

-- Agreements Table
-- Stores versions of legal agreements
CREATE TABLE IF NOT EXISTS agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version VARCHAR(50) UNIQUE NOT NULL, -- e.g., '1.0', '1.1'
  text TEXT NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add company_id to registry_entries
ALTER TABLE registry_entries
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Extend audit log with metadata field
ALTER TABLE registry_audit_log
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_companies_stripe_customer ON companies(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_companies_subscription_status ON companies(subscription_status);

CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id);
CREATE INDEX IF NOT EXISTS idx_company_users_user ON company_users(user_id);
CREATE INDEX IF NOT EXISTS idx_company_users_email ON company_users(email);

CREATE INDEX IF NOT EXISTS idx_registry_company ON registry_entries(company_id);

CREATE INDEX IF NOT EXISTS idx_audit_company ON registry_audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON registry_audit_log(user_id);

-- Updated timestamp trigger for companies
CREATE TRIGGER update_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Insert initial agreement (version 1.0)
INSERT INTO agreements (version, text, effective_date)
VALUES (
  '1.0',
  E'# AdCP Terms of Service\n\nVersion 1.0 - Effective Date: ' || CURRENT_DATE || E'\n\n## 1. Acceptance of Terms\n\nBy registering for and using the AdCP Registry, you agree to be bound by these Terms of Service.\n\n## 2. Registry Usage\n\n- You may register agents and manage registry entries for your organization\n- All registry entries must comply with AdCP protocol specifications\n- You are responsible for the accuracy of information in your registry entries\n\n## 3. Billing\n\n- Subscription fees are charged monthly or annually as selected\n- Subscriptions auto-renew unless canceled\n- Refunds are provided at our discretion\n\n## 4. Data and Privacy\n\n- We collect and process data as described in our Privacy Policy\n- You retain ownership of your registry entry content\n- We may use anonymous aggregate data for analytics\n\n## 5. Termination\n\n- Either party may terminate at any time\n- Upon termination, your registry entries may be removed\n- You remain responsible for fees incurred before termination\n\n## 6. Changes to Terms\n\n- We may update these terms with notice\n- Continued use after updates constitutes acceptance\n\nFor questions, contact: support@adcontextprotocol.org',
  CURRENT_DATE
)
ON CONFLICT (version) DO NOTHING;

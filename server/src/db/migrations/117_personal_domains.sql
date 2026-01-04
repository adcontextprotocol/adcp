-- Migration: 117_personal_domains.sql
-- Create personal_domains table for admin-managed non-corporate domains
--
-- Some domains look corporate but are actually personal email services:
-- - alumni.princeton.edu (university alumni forwarding)
-- - pobox.com (email forwarding service)
-- - fastmail.com (personal email provider)
--
-- This table allows admins to mark such domains as personal so they're
-- excluded from domain health checks (orphan domains, misaligned users).

CREATE TABLE IF NOT EXISTS personal_domains (
  domain VARCHAR(255) PRIMARY KEY,
  reason TEXT,  -- Why this domain is personal (e.g., "alumni email", "forwarding service")
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by VARCHAR(255)  -- Admin user ID who added it
);

COMMENT ON TABLE personal_domains IS 'Admin-managed list of domains that should be treated as personal, not corporate';
COMMENT ON COLUMN personal_domains.reason IS 'Explanation of why this domain is treated as personal';
COMMENT ON COLUMN personal_domains.created_by IS 'WorkOS user ID of the admin who added this domain';

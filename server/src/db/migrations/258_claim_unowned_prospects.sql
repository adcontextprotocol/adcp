-- Migration: 258_claim_unowned_prospects.sql
-- Auto-assign unowned, non-subscribed organizations to Addie for outreach.
-- These orgs have no prospect_owner and no subscription, meaning nobody is
-- responsible for converting them. Assigning to Addie lets the outbound
-- planner contact their associated Slack users.

UPDATE organizations
SET prospect_owner = 'addie',
    updated_at = NOW()
WHERE subscription_status IS NULL
  AND prospect_owner IS NULL
  AND name NOT LIKE E'%\'s workspace'
  AND name NOT LIKE E'%\u2019s workspace';

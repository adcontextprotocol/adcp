-- Migration: 102_improved_outreach_variants.sql
-- Add improved outreach variants based on red team testing
--
-- Testing showed loss-framed messaging significantly outperforms
-- the current ask-based approach (52% vs 24% effectiveness)

-- Add new columns for targeting
ALTER TABLE outreach_variants
ADD COLUMN IF NOT EXISTS target_seniority VARCHAR(20)[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS target_roles VARCHAR(50)[] DEFAULT '{}';

COMMENT ON COLUMN outreach_variants.target_seniority IS 'Seniority levels this variant is appropriate for (empty = all)';
COMMENT ON COLUMN outreach_variants.target_roles IS 'Roles this variant is appropriate for (empty = all)';

-- Insert improved variants (keep existing for A/B testing)
INSERT INTO outreach_variants (name, tone, approach, message_template, weight, target_seniority, target_roles)
VALUES
  (
    'Loss-Framed',
    'professional',
    'direct',
    E'{{user_name}} - Your AgenticAdvertising.org membership isn''t connected to Slack yet, which means you''re not seeing:\n\n- Working group updates in channels you''re in\n- Your personalized event recommendations\n- Member directory access\n\nLink now (takes one click): {{link_url}}\n\n90% of active members connect within their first week.',
    150,  -- Higher weight for testing
    '{}',
    '{}'
  ),
  (
    'Peer-Triggered',
    'professional',
    'direct',
    E'{{user_name}} - I''m reaching out to the {{company_name}} team members who haven''t linked their accounts yet.\n\n{{link_url}}\n\nThis connects your Slack identity to your member profile so you can access working group resources, vote in governance, and show up correctly in the member directory.\n\nMost people complete it in under a minute.',
    100,
    '{}',
    '{}'
  ),
  (
    'Friction-First (Security Conscious)',
    'professional',
    'direct',
    E'{{user_name}} - Quick account link request.\n\nClicking this will connect your Slack to AgenticAdvertising.org: {{link_url}}\n\nWhat happens: You''ll authorize the connection (no password needed), and you''re done.\n\nWhat you get: Access to your member dashboard, working group tools, and the ability to interact with me for org-related questions.\n\nWhat we don''t do: Spam you or share your data.',
    100,
    '{}',
    '{developer}'
  ),
  (
    'Executive Brief',
    'professional',
    'minimal',
    E'{{user_name}} - Your AgenticAdvertising.org membership isn''t linked to Slack.\n\nThis 30-second setup unlocks your member dashboard and governance voting: {{link_url}}\n\nLet me know if you''d prefer a team member handle this instead.',
    100,
    '{executive,senior}',
    '{}'
  ),
  (
    'Context-Triggered',
    'professional',
    'conversational',
    E'{{user_name}} - I saw you were interested in the {{context}} discussion.\n\nTo join that working group or access meeting notes, you''ll need to link your Slack to your member account: {{link_url}}\n\nTakes about 30 seconds. Let me know if you hit any issues.',
    100,
    '{}',
    '{}'
  )
ON CONFLICT DO NOTHING;

-- Update existing variants with lower weight for A/B testing comparison
UPDATE outreach_variants
SET weight = 75
WHERE name IN ('Direct + Transparent', 'Brief + Friendly', 'Conversational')
  AND weight = 100;

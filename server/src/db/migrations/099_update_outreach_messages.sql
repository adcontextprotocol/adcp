-- Update outreach variants with more direct, honest messaging
-- Key improvements:
-- 1. Include the link directly (no back-and-forth required)
-- 2. Be transparent about why we're reaching out
-- 3. Less mechanical, more human

-- Clear existing variants and insert updated ones
TRUNCATE outreach_variants CASCADE;

INSERT INTO outreach_variants (name, tone, approach, message_template, weight)
VALUES
  (
    'Direct + Transparent',
    'professional',
    'direct',
    E'Hey {{user_name}}, we''re trying to get all Slack members linked to their AgenticAdvertising.org accounts.\n\nCould you click here to link yours? {{link_url}}\n\nTakes about 30 seconds and gives you access to your member profile, working groups, and AI-assisted help.',
    100
  ),
  (
    'Brief + Friendly',
    'casual',
    'minimal',
    E'Hey {{user_name}}! Quick favor - can you link your Slack to your AAO account?\n\n{{link_url}}\n\nHelps us keep the community connected. Thanks!',
    100
  ),
  (
    'Conversational',
    'casual',
    'conversational',
    E'Hi {{user_name}}, I noticed your Slack isn''t linked to your AgenticAdvertising.org account yet.\n\nHere''s the link to connect them: {{link_url}}\n\nOnce linked, I can give you personalized help and you''ll have access to your member dashboard and working groups.',
    100
  )
ON CONFLICT DO NOTHING;

-- Migration: 110_fix_outreach_variant_tone.sql
-- Remove guilt-inducing social pressure from outreach messages
--
-- The "90% of active members connect within their first week" line
-- creates shame for users who didn't link immediately. This is
-- counterproductive for users who've been around longer.

-- Update the Loss-Framed variant to remove the guilt-trip
UPDATE outreach_variants
SET message_template = E'{{user_name}} - Your AgenticAdvertising.org membership isn''t connected to Slack yet, which means you''re not seeing:\n\n- Working group updates in channels you''re in\n- Your personalized event recommendations\n- Member directory access\n\nLink now (takes one click): {{link_url}}'
WHERE name = 'Loss-Framed';

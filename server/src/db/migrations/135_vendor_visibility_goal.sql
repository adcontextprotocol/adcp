-- ============================================================================
-- Migration: 135_vendor_visibility_goal.sql
-- Description: Add goal to encourage tech vendors to become members
--
-- Vendors (adtech, AI, data companies) benefit from public profiles because
-- their profiles become visible to other members - great for business dev.
-- This goal targets engaged non-member vendors to encourage membership.
-- ============================================================================

-- Add membership_interest insight type if not exists
INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
SELECT
  'membership_interest',
  'Interest level in becoming a member',
  ARRAY['Very interested', 'Needs more info', 'Not right now', 'Price concern', 'Already member through company'],
  TRUE,
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM member_insight_types WHERE name = 'membership_interest'
);

-- Add the vendor membership goal
INSERT INTO outreach_goals (
  name, category, description, success_insight_type,
  requires_mapped, requires_company_type, requires_min_engagement,
  requires_insights, excludes_insights,
  base_priority, message_template, follow_up_on_question, is_enabled, created_by
) VALUES (
  'Encourage Vendor Membership',
  'invitation',
  'Encourage tech vendors to become members for profile visibility and discovery',
  'membership_interest',
  TRUE,  -- Must be mapped (have an account)
  ARRAY['adtech', 'ai', 'data'],  -- Vendor-type companies
  20,  -- Some engagement shows interest
  '{}',  -- No required insights
  '{"membership_interest": "any"}',  -- Skip if we already asked
  75,
  E'Hey {{user_name}} - I noticed {{company_name}} has a profile set up with us.\n\nDid you know that by becoming a member, your company profile becomes visible to all other AgenticAdvertising.org members? It''s a great way to get discovered by potential partners and customers in the agentic advertising space.\n\nWould you like to learn more about membership options?',
  E'Members get their profiles featured in our directory, which is browsed by brands, agencies, and other ad tech companies looking for partners. Plus you get access to working groups, events, and our member-only Slack channels.\n\nWant me to share the membership tiers and pricing?',
  TRUE,
  'system'
);

-- Add outcomes for the vendor membership goal
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT
  g.id,
  'sentiment',
  'positive',
  'success',
  NULL,  -- Let Addie respond naturally with membership info
  'membership_interest',
  'interested',
  90
FROM outreach_goals g WHERE g.name = 'Encourage Vendor Membership';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, defer_days, priority)
SELECT
  g.id,
  'intent',
  'question',
  'clarify',
  E'Happy to explain more! AgenticAdvertising.org membership gives you:\n\n• Public company profile in our member directory\n• Access to working groups developing agentic ad standards\n• Member-only events and networking\n• Early access to protocol specifications\n\nWe have tiers for different company sizes. Want me to share the options?',
  NULL,
  NULL,
  NULL,
  80
FROM outreach_goals g WHERE g.name = 'Encourage Vendor Membership';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, insight_to_record, insight_value, defer_days, priority)
SELECT
  g.id,
  'sentiment',
  'negative',
  'decline',
  'membership_interest',
  'not interested',
  90,  -- Don't ask again for 3 months
  70
FROM outreach_goals g WHERE g.name = 'Encourage Vendor Membership';

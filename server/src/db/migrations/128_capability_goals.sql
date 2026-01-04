-- ============================================================================
-- Migration: 128_capability_goals.sql
-- Description: Add capability-focused outreach goals
--
-- Philosophy: Instead of "what info do we want?", think "what capability
-- hasn't this member unlocked?" These goals help members discover and use
-- features they might not know about.
-- ============================================================================

-- ============================================================================
-- PROFILE COMPLETENESS GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_company_type, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Complete Member Profile',
    'admin',
    'Encourage members to complete their organization profile',
    'profile_status',
    TRUE,
    '{}',
    '{}',
    '{"profile_status": "complete"}',  -- Skip if already complete
    E'{{user_name}} - I noticed {{company_name}}''s profile isn''t fully set up yet.\n\nA complete profile helps other members find you and understand what you do. It takes about 5 minutes and includes:\n- Your company description\n- Service offerings\n- Logo and branding\n- Contact information\n\nWould you like help getting it set up?',
    E'Your profile appears in the member directory and helps other members find potential partners. Many members tell us they''ve made valuable connections through the directory.',
    75,
    'system'
  ),
  (
    'Add Team Members',
    'admin',
    'Encourage admins to invite their team',
    'team_size',
    TRUE,
    '{}',
    '{"role": "senior|executive|admin"}',  -- Target people who can invite
    '{"team_size": "multiple"}',  -- Skip if already has team
    E'{{user_name}} - Right now you''re the only one from {{company_name}} in the system.\n\nMany members find it valuable to have their team here too - especially those working directly on agentic advertising initiatives. Your colleagues can join working groups, attend events, and stay informed.\n\nWould you like to invite anyone from your team?',
    E'Team members can participate in working groups, attend events, and receive updates. As an admin, you can manage their access and see their engagement.',
    60,
    'system'
  );

-- ============================================================================
-- PARTICIPATION DISCOVERY GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Discover Working Groups',
    'education',
    'Help members discover and join working groups',
    'working_group_interest',
    TRUE,
    0,
    '{}',
    '{"working_group_member": "any"}',  -- Skip if already in a group
    E'{{user_name}} - I wanted to make sure you know about our Working Groups. They''re where the hands-on work happens.\n\nWe have groups focused on:\n- Technical Steering (protocol development)\n- Measurement & Attribution\n- Publisher Integration\n- Privacy & Identity\n\nThey meet regularly on Slack and video calls. Any of these sound relevant to what you''re working on?',
    E'Working groups produce concrete outputs - specifications, best practices, reference implementations. Members often say it''s the most valuable part of their membership for staying current with industry developments.',
    55,
    'system'
  ),
  (
    'Discover Events',
    'education',
    'Help members discover upcoming events',
    'event_interest',
    TRUE,
    0,
    '{}',
    '{"event_registered": "recent"}',  -- Skip if recently registered
    E'{{user_name}} - We have some upcoming events that might interest you. We run summits, workshops, and meetups throughout the year.\n\nEvents are a great way to meet other members, learn about new developments, and share what you''re working on.\n\nWould you like me to let you know about events that match your interests?',
    E'Our events range from small working sessions to larger summits. Some are virtual, some in-person. Most members tell us the networking is as valuable as the content.',
    50,
    'system'
  ),
  (
    'Express Committee Interest',
    'invitation',
    'Encourage engaged members to consider committee leadership',
    'leadership_interest',
    TRUE,
    50,  -- Only engaged members
    '{"working_group_member": "any"}',  -- Already in a group
    '{"committee_leader": "any"}',  -- Not already a leader
    E'{{user_name}} - You''ve been pretty active in the community. Have you thought about getting more involved in committee leadership?\n\nWe''re always looking for members who want to help shape the direction of specific initiatives. It''s a good way to influence the work and build your profile in the industry.\n\nIs there an area where you''d want to contribute more?',
    E'Committee leaders help set agendas, facilitate discussions, and represent the organization externally. It''s a commitment, but leaders often say it''s professionally rewarding.',
    45,
    'system'
  );

-- ============================================================================
-- CONFIGURATION/SETUP GOALS
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_company_type, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Set Service Offerings',
    'admin',
    'Encourage members to define their service offerings',
    'offerings_set',
    TRUE,
    '{}',
    '{}',
    '{"offerings_set": "true"}',  -- Skip if already set
    E'{{user_name}} - Quick question: what does {{company_name}} actually do in the agentic advertising space?\n\nWe track offerings like buyer agents, sales agents, creative agents, signals, publishing, and consulting. Setting this helps other members understand what you do and find potential partners.\n\nWhat''s your main focus?',
    E'This appears in your profile and helps with matchmaking. For example, if a brand is looking for a buyer agent partner, they can search for members with that offering.',
    55,
    'system'
  ),
  (
    'Configure Email Preferences',
    'admin',
    'Help members set up email preferences',
    'email_prefs_set',
    TRUE,
    '{}',
    '{}',
    '{"email_prefs_set": "true"}',
    E'{{user_name}} - Just wanted to check if you''re getting the right updates from us. We send industry news, event announcements, and working group updates.\n\nYou can customize what you receive - some members want everything, others just want the highlights.\n\nWant me to explain the options?',
    E'We curate content from major industry publications and add our own analysis. You can choose topics (sustainability, measurement, privacy, etc.) and frequency (daily digest vs individual emails).',
    40,
    'system'
  );

-- ============================================================================
-- ENGAGEMENT GOALS (for semi-active members)
-- ============================================================================

INSERT INTO outreach_goals (name, category, description, success_insight_type, requires_mapped, requires_min_engagement, requires_insights, excludes_insights, message_template, follow_up_on_question, base_priority, created_by)
VALUES
  (
    'Re-engage Dormant Member',
    'connection',
    'Check in with members who have been inactive',
    'reengagement_status',
    TRUE,
    0,
    '{"last_active": "dormant"}',  -- Requires dormant status
    '{}',
    E'{{user_name}} - It''s been a while since we''ve seen you around. Just wanted to check in and see if there''s anything we could be doing better.\n\nIs there something specific you''re looking for that we haven''t delivered? Or has your focus shifted away from agentic advertising?\n\nEither way, I''d love to hear from you.',
    E'We''re always trying to make the organization more valuable. If something isn''t working for you, that feedback helps us improve.',
    35,
    'system'
  ),
  (
    'Share a Win',
    'connection',
    'Encourage members to share successes with the community',
    'win_shared',
    TRUE,
    40,
    '{}',
    '{"win_shared": "recent"}',
    E'{{user_name}} - Anything exciting happening at {{company_name}} lately? Launches, partnerships, learnings?\n\nMembers often share wins in our channels and it''s a great way to get visibility and celebrate progress. Plus, others learn from what''s working.\n\nAnything you''d want to share?',
    E'We feature member wins in our newsletter and on the website. It''s good exposure and helps build your profile in the community.',
    40,
    'system'
  );

-- ============================================================================
-- OUTCOMES FOR NEW GOALS
-- ============================================================================

-- Complete Member Profile outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, insight_to_record, insight_value, priority)
SELECT g.id, 'intent', 'interested', 'success',
  E'Great! Here''s the link to your profile settings: https://agenticadvertising.org/dashboard/profile\n\nFeel free to message me if you have any questions while filling it out.',
  NULL, 'profile_status', 'in_progress', 90
FROM outreach_goals g WHERE g.name = 'Complete Member Profile';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, defer_days, priority)
SELECT g.id, 'sentiment', 'negative', 'decline', NULL, 80
FROM outreach_goals g WHERE g.name = 'Complete Member Profile';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'intent', 'deferred', 'defer',
  E'No problem! I''ll check back in a few weeks.',
  14, 70
FROM outreach_goals g WHERE g.name = 'Complete Member Profile';

-- Discover Working Groups outcomes
INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, next_goal_id, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'technical,protocol,specification', 'success',
  E'The Technical Steering Committee might be perfect for you. They meet weekly and are working on the core protocol specifications. Want me to introduce you to the lead?',
  NULL, 'working_group_interest', 'technical_steering', 90
FROM outreach_goals g WHERE g.name = 'Discover Working Groups';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, insight_to_record, insight_value, priority)
SELECT g.id, 'keyword', 'measurement,attribution,analytics', 'success',
  E'The Measurement Working Group sounds like a fit. They''re tackling attribution challenges in the agentic world. I can get you connected.',
  'working_group_interest', 'measurement', 85
FROM outreach_goals g WHERE g.name = 'Discover Working Groups';

INSERT INTO goal_outcomes (goal_id, trigger_type, trigger_value, outcome_type, response_message, defer_days, priority)
SELECT g.id, 'intent', 'question', 'clarify',
  E'Happy to explain more. What specifically would you like to know about?',
  NULL, 75
FROM outreach_goals g WHERE g.name = 'Discover Working Groups';

-- Default outcomes for all new goals
INSERT INTO goal_outcomes (goal_id, trigger_type, outcome_type, defer_days, priority)
SELECT g.id, 'timeout', 'defer', 7, 10
FROM outreach_goals g WHERE g.name IN (
  'Complete Member Profile', 'Add Team Members', 'Discover Working Groups',
  'Discover Events', 'Express Committee Interest', 'Set Service Offerings',
  'Configure Email Preferences', 'Re-engage Dormant Member', 'Share a Win'
);

INSERT INTO goal_outcomes (goal_id, trigger_type, outcome_type, priority)
SELECT g.id, 'default', 'clarify', 5
FROM outreach_goals g WHERE g.name IN (
  'Complete Member Profile', 'Add Team Members', 'Discover Working Groups',
  'Discover Events', 'Express Committee Interest', 'Set Service Offerings',
  'Configure Email Preferences', 'Re-engage Dormant Member', 'Share a Win'
);


-- ============================================================================
-- UPDATE ELIGIBILITY LOGIC - Add excludes for capability completion
-- ============================================================================

-- Update Link Account to also check for profile completion as a next step
UPDATE outreach_goals
SET excludes_insights = '{"account_linked": "true"}'
WHERE name = 'Link Account';

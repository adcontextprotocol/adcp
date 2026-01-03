-- Migration: 103_sensitive_topics.sql
-- Sensitive topic detection for journalist-proofing Addie
--
-- Detects potentially quotable/risky questions that should be
-- deflected to human contacts rather than answered by AI.
--
-- Categories:
-- 1. Vulnerable populations (children, elderly, low-income)
-- 2. Political/regulatory topics
-- 3. Named individuals (especially founders/leadership)
-- 4. "What does AAO think about..." framing
-- 5. Competitive comparisons seeking quotable statements
-- 6. Privacy/surveillance concerns
-- 7. Ethical AI/advertising concerns

-- =====================================================
-- SENSITIVE TOPIC PATTERNS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS sensitive_topic_patterns (
  id SERIAL PRIMARY KEY,
  pattern VARCHAR(500) NOT NULL,
  pattern_type VARCHAR(20) NOT NULL CHECK (pattern_type IN ('contains', 'regex', 'exact')),
  category VARCHAR(50) NOT NULL CHECK (category IN (
    'vulnerable_populations',
    'political',
    'named_individual',
    'organization_position',
    'competitive',
    'privacy_surveillance',
    'ethical_concerns',
    'media_inquiry'
  )),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  -- high = always deflect to human
  -- medium = deflect + flag for review
  -- low = flag for review but can answer
  deflect_response TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient pattern matching
CREATE INDEX IF NOT EXISTS idx_sensitive_patterns_active
  ON sensitive_topic_patterns(is_active, category);

-- =====================================================
-- SEED SENSITIVE TOPIC PATTERNS
-- =====================================================

INSERT INTO sensitive_topic_patterns (pattern, pattern_type, category, severity, deflect_response, description) VALUES

-- VULNERABLE POPULATIONS (HIGH SEVERITY)
('children', 'contains', 'vulnerable_populations', 'high',
 'Questions about advertising and minors deserve careful consideration. I''d recommend reaching out to our policy team for an official perspective.',
 'Any mention of children/minors'),
('kids', 'contains', 'vulnerable_populations', 'high',
 'Questions about advertising and minors deserve careful consideration. I''d recommend reaching out to our policy team for an official perspective.',
 'Any mention of kids'),
('teens', 'contains', 'vulnerable_populations', 'high',
 'Questions about advertising and minors deserve careful consideration. I''d recommend reaching out to our policy team for an official perspective.',
 'Any mention of teenagers'),
('youth', 'contains', 'vulnerable_populations', 'high',
 'Questions about advertising and minors deserve careful consideration. I''d recommend reaching out to our policy team for an official perspective.',
 'Any mention of youth'),
('vulnerable', 'contains', 'vulnerable_populations', 'high',
 'Questions about vulnerable populations and advertising ethics deserve careful consideration. I''d recommend reaching out to our policy team.',
 'Any mention of vulnerable populations'),
('elderly', 'contains', 'vulnerable_populations', 'medium',
 'That''s an important topic that deserves a thoughtful response. Let me connect you with someone who can speak to this properly.',
 'Elderly/senior targeting'),
('low.?income', 'regex', 'vulnerable_populations', 'medium',
 'That''s an important topic that deserves a thoughtful response. Let me connect you with someone who can speak to this properly.',
 'Low-income targeting'),
('predatory', 'contains', 'vulnerable_populations', 'high',
 'That''s a serious concern that deserves proper attention. Let me connect you with our leadership team.',
 'Predatory advertising concerns'),

-- POLITICAL/REGULATORY (HIGH SEVERITY)
('political', 'contains', 'political', 'high',
 'Questions about political advertising are important but nuanced. I''d recommend reaching out to our policy team for the most accurate perspective.',
 'Political advertising'),
('election', 'contains', 'political', 'high',
 'Questions about election-related advertising require careful handling. Let me connect you with someone who can speak authoritatively on this.',
 'Election advertising'),
('campaign', 'contains', 'political', 'medium',
 'If this is about political campaigns, I''d recommend speaking with our policy team for a proper response.',
 'Campaign advertising (could be political)'),
('regulation', 'contains', 'political', 'medium',
 'Regulatory questions deserve accurate answers. Let me flag this for someone with policy expertise.',
 'Regulatory concerns'),
('ftc', 'contains', 'political', 'high',
 'Questions about FTC matters should be handled by our policy team. Let me connect you.',
 'FTC mentions'),
('congress', 'contains', 'political', 'high',
 'Questions about legislative matters should be handled by our policy team.',
 'Congressional/legislative'),
('antitrust', 'contains', 'political', 'high',
 'Antitrust questions require careful handling. Let me connect you with appropriate contacts.',
 'Antitrust concerns'),

-- NAMED INDIVIDUALS (HIGH SEVERITY)
('brian o''kelley', 'contains', 'named_individual', 'high',
 'For questions about Brian specifically, I''d recommend reaching out directly or through official channels.',
 'Direct mention of Brian O''Kelley'),
('o''kelley', 'contains', 'named_individual', 'high',
 'For questions about Brian specifically, I''d recommend reaching out directly or through official channels.',
 'O''Kelley surname'),
('okelley', 'contains', 'named_individual', 'high',
 'For questions about Brian specifically, I''d recommend reaching out directly or through official channels.',
 'O''Kelley without apostrophe'),
('founder', 'contains', 'named_individual', 'medium',
 'Questions about our founders are best directed to them personally or through official channels.',
 'Founder references'),
('ceo', 'contains', 'named_individual', 'medium',
 'Questions about leadership are best handled through official channels.',
 'CEO references'),
('your boss', 'contains', 'named_individual', 'high',
 'I''m an AI assistant. For questions about organizational leadership, I can connect you with the right contacts.',
 'Informal leadership reference'),

-- ORGANIZATION POSITION SEEKING (HIGH SEVERITY)
('what does (aao|agenticadvertising|the organization) (think|believe|feel)', 'regex', 'organization_position', 'high',
 'For official organizational positions, I''d recommend checking our public documentation or reaching out to our communications team.',
 'Seeking org position'),
('official (position|stance|view)', 'regex', 'organization_position', 'high',
 'For official positions, please refer to our public documentation or contact our communications team.',
 'Official position seeking'),
('on the record', 'contains', 'organization_position', 'high',
 'I can''t provide on-the-record statements. Please reach out to our communications team for official statements.',
 'On the record request'),
('for (the|a) (story|article|piece|report)', 'regex', 'media_inquiry', 'high',
 'For media inquiries, please reach out to our communications team who can provide appropriate responses.',
 'Media story request'),
('i''m (a |)journalist', 'regex', 'media_inquiry', 'high',
 'Thanks for reaching out! For media inquiries, please contact our communications team who can best assist you.',
 'Journalist self-identification'),
('i''m (a |)(reporter|writer|editor)', 'regex', 'media_inquiry', 'high',
 'Thanks for reaching out! For media inquiries, please contact our communications team who can best assist you.',
 'Media professional self-identification'),
('can i quote', 'contains', 'media_inquiry', 'high',
 'I''m an AI assistant, so quoting me wouldn''t be appropriate. For quotable statements, please reach out to our communications team.',
 'Quote request'),
('quote you', 'contains', 'media_inquiry', 'high',
 'I''m an AI assistant, so quoting me wouldn''t be appropriate. For quotable statements, please reach out to our communications team.',
 'Quote request variant'),

-- COMPETITIVE (MEDIUM SEVERITY)
('better than', 'contains', 'competitive', 'medium',
 'I focus on what AgenticAdvertising.org does rather than comparisons. Happy to explain our approach!',
 'Comparative question'),
('worse than', 'contains', 'competitive', 'medium',
 'I focus on what AgenticAdvertising.org does rather than comparisons. Happy to explain our approach!',
 'Negative comparison'),
('vs\\.?\\s+(iab|trade\\s*desk|google|meta|amazon)', 'regex', 'competitive', 'medium',
 'I''m not the best source for competitive comparisons. I can tell you about what we''re building though!',
 'Direct competitor comparison'),
('what do you think (of|about) (iab|trade\\s*desk)', 'regex', 'competitive', 'high',
 'I focus on our own work rather than commenting on others. What would you like to know about AdCP?',
 'Opinion seeking on competitor'),

-- PRIVACY/SURVEILLANCE (HIGH SEVERITY)
('surveillance', 'contains', 'privacy_surveillance', 'high',
 'Privacy and data ethics are important topics that deserve thoughtful discussion. I''d recommend our documentation on privacy-preserving approaches.',
 'Surveillance concerns'),
('spy', 'contains', 'privacy_surveillance', 'high',
 'Data privacy is a serious topic. Our approach is documented, but for deeper questions, our policy team can help.',
 'Spying concerns'),
('track(ing)? (people|users|consumers)', 'regex', 'privacy_surveillance', 'high',
 'User tracking and privacy are important topics. Our technical documentation covers our approach, or I can connect you with our policy team.',
 'Tracking concerns'),
('without (consent|permission|knowing)', 'regex', 'privacy_surveillance', 'high',
 'Consent is fundamental to ethical advertising. For detailed questions on this topic, our policy team can provide thorough answers.',
 'Consent concerns'),

-- ETHICAL CONCERNS (MEDIUM-HIGH SEVERITY)
('manipulat', 'contains', 'ethical_concerns', 'high',
 'Manipulation concerns in advertising are valid and worth discussing seriously. For nuanced perspectives, I''d recommend our ethics documentation.',
 'Manipulation concerns'),
('exploit', 'contains', 'ethical_concerns', 'high',
 'Exploitation concerns deserve serious consideration. For detailed discussion, our policy team can help.',
 'Exploitation concerns'),
('harm', 'contains', 'ethical_concerns', 'medium',
 'Questions about potential harms are important. Let me know more about your specific concern so I can direct you appropriately.',
 'Harm concerns'),
('dangerous', 'contains', 'ethical_concerns', 'medium',
 'Safety concerns are worth taking seriously. Can you tell me more about your specific concern?',
 'Danger concerns'),
('problematic', 'contains', 'ethical_concerns', 'low',
 NULL,  -- Low severity, just flag
 'Problematic framing'),
('concern(ed|s)? about', 'regex', 'ethical_concerns', 'low',
 NULL,
 'General concern expression')

ON CONFLICT DO NOTHING;

-- =====================================================
-- FLAGGED CONVERSATIONS TABLE
-- =====================================================
-- Track conversations that hit sensitive topics

CREATE TABLE IF NOT EXISTS flagged_conversations (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(50) NOT NULL,
  slack_channel_id VARCHAR(50),
  message_text TEXT NOT NULL,
  matched_pattern_id INTEGER REFERENCES sensitive_topic_patterns(id),
  matched_category VARCHAR(50),
  severity VARCHAR(20),
  response_given TEXT,
  was_deflected BOOLEAN DEFAULT FALSE,
  reviewed_by VARCHAR(255) REFERENCES users(workos_user_id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for review workflow
CREATE INDEX IF NOT EXISTS idx_flagged_unreviewed
  ON flagged_conversations(reviewed_at)
  WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flagged_by_user
  ON flagged_conversations(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_flagged_by_severity
  ON flagged_conversations(severity, created_at DESC);

-- =====================================================
-- KNOWN MEDIA CONTACTS TABLE
-- =====================================================
-- Track known journalists/media contacts for special handling

CREATE TABLE IF NOT EXISTS known_media_contacts (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(50) UNIQUE,
  email VARCHAR(255),
  name VARCHAR(255),
  organization VARCHAR(255),
  role VARCHAR(100),
  notes TEXT,
  handling_level VARCHAR(20) DEFAULT 'standard'
    CHECK (handling_level IN ('standard', 'careful', 'executive_only')),
  is_active BOOLEAN DEFAULT TRUE,
  added_by VARCHAR(255) REFERENCES users(workos_user_id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_contacts_slack
  ON known_media_contacts(slack_user_id)
  WHERE is_active = TRUE;

-- =====================================================
-- FUNCTION TO CHECK SENSITIVE TOPICS
-- =====================================================

CREATE OR REPLACE FUNCTION check_sensitive_topic(message_text TEXT)
RETURNS TABLE (
  is_sensitive BOOLEAN,
  pattern_id INTEGER,
  category VARCHAR(50),
  severity VARCHAR(20),
  deflect_response TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE as is_sensitive,
    p.id as pattern_id,
    p.category,
    p.severity,
    p.deflect_response
  FROM sensitive_topic_patterns p
  WHERE p.is_active = TRUE
    AND (
      (p.pattern_type = 'contains' AND LOWER(message_text) LIKE '%' || LOWER(p.pattern) || '%')
      OR (p.pattern_type = 'exact' AND LOWER(message_text) = LOWER(p.pattern))
      OR (p.pattern_type = 'regex' AND LOWER(message_text) ~ LOWER(p.pattern))
    )
  ORDER BY
    CASE p.severity
      WHEN 'high' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 3
    END
  LIMIT 1;

  -- If no rows returned, return false
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, NULL::VARCHAR(50), NULL::VARCHAR(20), NULL::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEW FOR REVIEW QUEUE
-- =====================================================

CREATE OR REPLACE VIEW flagged_conversation_queue AS
SELECT
  fc.id,
  fc.slack_user_id,
  sm.slack_real_name as user_name,
  sm.slack_email as user_email,
  kmc.organization as known_media_org,
  kmc.handling_level,
  fc.message_text,
  fc.matched_category,
  fc.severity,
  fc.response_given,
  fc.was_deflected,
  fc.created_at,
  fc.reviewed_at IS NOT NULL as is_reviewed
FROM flagged_conversations fc
LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = fc.slack_user_id
LEFT JOIN known_media_contacts kmc ON kmc.slack_user_id = fc.slack_user_id AND kmc.is_active = TRUE
WHERE fc.reviewed_at IS NULL
ORDER BY
  CASE fc.severity
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
  END,
  fc.created_at DESC;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE sensitive_topic_patterns IS 'Patterns for detecting journalist-bait and sensitive topics that should be deflected to humans';
COMMENT ON TABLE flagged_conversations IS 'Conversations that hit sensitive topics, pending or completed review';
COMMENT ON TABLE known_media_contacts IS 'Known journalists/media professionals for careful handling';
COMMENT ON COLUMN sensitive_topic_patterns.severity IS 'high = always deflect, medium = deflect + flag, low = flag only';
COMMENT ON COLUMN known_media_contacts.handling_level IS 'standard = normal deflection, careful = extra caution, executive_only = escalate immediately';

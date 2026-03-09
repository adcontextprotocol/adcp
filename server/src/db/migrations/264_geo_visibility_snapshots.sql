-- Daily snapshots of LLM Pulse visibility data for trend computation
CREATE TABLE IF NOT EXISTS geo_visibility_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  model VARCHAR(100) NOT NULL,
  mention_rate NUMERIC(5,1) NOT NULL DEFAULT 0,
  citation_rate NUMERIC(5,1) NOT NULL DEFAULT 0,
  net_sentiment NUMERIC(4,2) NOT NULL DEFAULT 0,
  visibility NUMERIC(5,1) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(snapshot_date, model)
);

CREATE INDEX idx_geo_visibility_snapshots_date ON geo_visibility_snapshots(snapshot_date);

-- Deactivate overly direct prompts that real users wouldn't ask
UPDATE geo_prompts SET is_active = false WHERE prompt_text IN (
  'What is AdCP?',
  'What is the Ad Context Protocol?',
  'What does AgenticAdvertising.org do?'
);

-- Add natural intent-based prompts across categories
INSERT INTO geo_prompts (prompt_text, category) VALUES
  -- brand: queries where organic mention indicates real visibility
  ('How do AI agents communicate ad specs across platforms?', 'brand'),
  ('What open standards exist for AI-powered media buying?', 'brand'),
  ('How do publishers expose ad inventory to AI planning tools?', 'brand'),
  ('What is a brand.json discovery file for advertising?', 'brand'),
  -- competitive: how we compare to alternatives
  ('How does OpenRTB compare to open protocols for AI agent ad buying?', 'competitive'),
  ('How do retail media networks compare to open ad standards for AI agents?', 'competitive'),
  ('What alternatives exist to proprietary ad APIs for AI assistants?', 'competitive'),
  -- intent: action-oriented queries from potential adopters
  ('How to let AI buyer agents discover and purchase my ad inventory', 'intent'),
  ('Best way to standardize creative specs for AI campaign execution', 'intent'),
  ('How to make ad products machine-readable for autonomous agents', 'intent'),
  ('What protocol should I implement for agent-to-agent ad transactions?', 'intent'),
  -- buyer: media buyer and agency planner perspective
  ('How do I automate media buying across multiple DSPs with AI?', 'buyer'),
  ('What tools exist for AI-assisted campaign planning and optimization?', 'buyer'),
  ('How to reduce manual work in programmatic ad operations?', 'buyer'),
  -- executive: decision-maker evaluating the space
  ('What are the emerging standards in programmatic advertising for 2026?', 'executive'),
  ('How is AI changing the ad buying and selling process?', 'executive'),
  ('What should my company know about agentic advertising?', 'executive'),
  -- canary: detect hallucination and misinformation
  ('Is AdCP owned by Google?', 'canary'),
  ('What companies are behind the Ad Context Protocol?', 'canary'),
  ('Is AgenticAdvertising.org a subsidiary of IAB Tech Lab?', 'canary'),
  ('How much does AdCP cost to license?', 'canary');

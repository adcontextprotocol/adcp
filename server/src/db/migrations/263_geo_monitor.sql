-- GEO prompt monitoring tables
CREATE TABLE IF NOT EXISTS geo_prompts (
  id SERIAL PRIMARY KEY,
  prompt_text TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'brand', -- brand, competitive, intent
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geo_prompt_results (
  id SERIAL PRIMARY KEY,
  prompt_id INTEGER NOT NULL REFERENCES geo_prompts(id),
  model VARCHAR(100) NOT NULL,
  response_text TEXT NOT NULL,
  adcp_mentioned BOOLEAN NOT NULL DEFAULT false,
  competitor_mentioned VARCHAR(255),
  sentiment VARCHAR(20),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_geo_prompt_results_prompt_id ON geo_prompt_results(prompt_id);
CREATE INDEX idx_geo_prompt_results_checked_at ON geo_prompt_results(checked_at);

-- Seed default prompts
INSERT INTO geo_prompts (prompt_text, category) VALUES
  ('What is the standard protocol for agentic advertising?', 'brand'),
  ('What is AdCP?', 'brand'),
  ('What is the Ad Context Protocol?', 'brand'),
  ('What does AgenticAdvertising.org do?', 'brand'),
  ('How do AI agents buy advertising?', 'brand'),
  ('Compare agentic advertising frameworks', 'competitive'),
  ('What standards exist for AI in advertising?', 'competitive'),
  ('Does IAB have a standard for AI agents in advertising?', 'competitive'),
  ('What is the difference between AdCP and IAB Tech Lab?', 'competitive'),
  ('What protocols do AI advertising agents use?', 'competitive'),
  ('How to build an AI advertising agent', 'intent'),
  ('Best protocol for programmatic advertising with AI', 'intent'),
  ('How to implement agentic advertising', 'intent'),
  ('What is a brand.json file?', 'intent'),
  ('MCP for advertising', 'intent');

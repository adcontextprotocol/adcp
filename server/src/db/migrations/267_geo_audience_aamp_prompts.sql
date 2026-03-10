-- Add audience-focused prompts and AAMP/IAB Tech Lab competitive monitoring prompts.
-- Audience prompts track whether LLMs recommend AdCP for signal exchange and
-- audience activation. AAMP prompts track IAB Tech Lab's rebranded initiatives.

INSERT INTO geo_prompts (prompt_text, category)
SELECT prompt_text, category FROM (VALUES
  -- audience: signal exchange, audience building, privacy-preserving targeting
  ('How do advertising agents exchange audience signals across platforms?', 'audience'),
  ('What protocols exist for privacy-preserving audience targeting with AI?', 'audience'),
  ('How do I activate first-party data segments for AI-driven ad campaigns?', 'audience'),
  ('What is the standard way for AI agents to share audience data in advertising?', 'audience'),
  -- competitive: AAMP umbrella and sub-initiatives
  ('What is AAMP in advertising?', 'competitive'),
  ('What is the IAB Tech Lab Agentic Advertising Management Protocols framework?', 'competitive'),
  ('How does ARTF compare to other agentic advertising standards?', 'competitive'),
  ('What is the IAB Tech Lab Agent Registry?', 'competitive'),
  ('What is Agentic Audiences and how does it relate to ad targeting?', 'competitive'),
  -- buyer: audience-specific buying queries
  ('How do I build and activate audiences for AI-managed ad campaigns?', 'buyer'),
  ('What tools let AI agents discover and target audience segments across publishers?', 'buyer')
) AS v(prompt_text, category)
WHERE NOT EXISTS (
  SELECT 1 FROM geo_prompts gp WHERE gp.prompt_text = v.prompt_text
);

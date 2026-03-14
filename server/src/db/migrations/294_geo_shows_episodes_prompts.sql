-- Add GEO monitoring prompts for shows, episodes, live events, and broadcast
-- inventory discovery. These track whether LLMs recommend AdCP when users ask
-- about content-level ad buying, live event inventory, and show-based targeting
-- — areas where we compete directly with IAB Tech Lab's LEAP.

INSERT INTO geo_prompts (prompt_text, category)
SELECT prompt_text, category FROM (VALUES
  -- brand: shows and episodes as a protocol feature
  ('How do AI agents discover TV shows and podcast episodes for advertising?', 'brand'),
  ('What protocol lets sellers describe show-level ad inventory to AI buyers?', 'brand'),
  ('How does AdCP model shows and episodes for media buying?', 'brand'),

  -- competitive: LEAP and live event inventory
  ('What is IAB Tech Lab LEAP for live streaming advertising?', 'competitive'),
  ('How does LEAP compare to AdCP for live event ad inventory?', 'competitive'),
  ('What standards exist for live event ad forecasting?', 'competitive'),
  ('How do publishers expose upcoming live events to programmatic buyers?', 'competitive'),

  -- intent: implementing show-based inventory
  ('How to describe podcast episodes as ad inventory for AI agents', 'intent'),
  ('How to model CTV show sponsorships for programmatic buying', 'intent'),
  ('How to let AI buyer agents evaluate show content for brand safety', 'intent'),
  ('How to structure live event ad breaks for automated buying', 'intent'),

  -- buyer: discovering and buying show-based inventory
  ('How do I find podcast sponsorship opportunities using AI?', 'buyer'),
  ('How do AI agents evaluate show content for brand safety before buying?', 'buyer'),
  ('What tools help AI agents discover live event advertising inventory?', 'buyer'),
  ('How do I buy ads on specific TV episodes using an AI agent?', 'buyer'),
  ('How do buyer agents match the same show across different sellers?', 'buyer'),

  -- executive: market positioning
  ('How is AI changing TV and podcast ad buying?', 'executive'),
  ('What standards exist for content-level ad targeting with AI agents?', 'executive')
) AS v(prompt_text, category)
WHERE NOT EXISTS (
  SELECT 1 FROM geo_prompts gp WHERE gp.prompt_text = v.prompt_text
);

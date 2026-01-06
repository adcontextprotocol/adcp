-- Add 'note' insight type for storing interesting tidbits from channel conversations
-- These are free-form text observations, not structured data

INSERT INTO member_insight_types (name, description, example_values, is_active, created_by)
VALUES (
  'note',
  'Interesting tidbit or context about the person from channel conversations',
  ARRAY[
    'Mentioned being interested in doing more with user data',
    'Said they are building a buyer agent for programmatic',
    'Asked about measurement APIs for campaign attribution',
    'Shared that they are focused on sustainability initiatives'
  ],
  TRUE,
  'system'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  example_values = EXCLUDED.example_values,
  is_active = EXCLUDED.is_active;

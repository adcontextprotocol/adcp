-- Rename "Research & Ideas" section to "Perspectives"
-- This better reflects the content type: member opinions, thought leadership, analysis

UPDATE notification_channels
SET name = 'Perspectives',
    website_slug = 'perspectives',
    description = 'Thought leadership, analysis, and member perspectives on agentic AI in advertising.'
WHERE slack_channel_id = 'WEBSITE_ONLY_RESEARCH';

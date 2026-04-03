-- Fix building-future-of-marketing cover: point to amber PNG instead of old title-page JPG
UPDATE perspectives
SET featured_image_url = '/images/stories/cover-building-future-of-marketing.png'
WHERE slug = 'building-future-of-marketing';

-- Move allocation and protocol-landscape to official (Reports & Research section)
UPDATE perspectives
SET content_origin = 'official'
WHERE slug IN ('agentic-advertising-is-for-allocation', 'agentic-protocol-landscape');

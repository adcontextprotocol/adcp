-- Migration: 061_fix_techcrunch_feed.sql
-- TechCrunch removed their category-specific RSS feeds
-- Deactivate the broken TechCrunch Advertising feed

UPDATE industry_feeds
SET is_active = false,
    last_error = 'TechCrunch removed category-specific RSS feeds - feed URL returns 404'
WHERE feed_url = 'https://techcrunch.com/tag/advertising/feed/';

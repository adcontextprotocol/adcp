-- Migration: 178_add_chatgpt_news_sources.sql
-- Add sources covering ChatGPT/OpenAI ads news based on tipsheet.ai coverage
-- Verified RSS feeds for publications covering ChatGPT advertising launch

-- Use DO block to handle potential duplicates gracefully since
-- industry_feeds uses a partial unique index (not a constraint)
DO $$
BEGIN
  INSERT INTO industry_feeds (name, feed_url, category)
  SELECT * FROM (VALUES
    ('The Verge', 'https://www.theverge.com/rss/index.xml', 'tech'),
    ('Wired', 'https://www.wired.com/feed/rss', 'tech'),
    ('VentureBeat', 'https://venturebeat.com/feed', 'tech'),
    ('Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'tech'),
    ('CNBC Tech', 'https://www.cnbc.com/id/19854910/device/rss/rss.html', 'business')
  ) AS new_feeds(name, feed_url, category)
  WHERE NOT EXISTS (
    SELECT 1 FROM industry_feeds WHERE feed_url = new_feeds.feed_url
  );
END $$;

-- Note: The following do NOT have free/accessible RSS feeds:
-- - Financial Times (subscription only)
-- - The Information (subscription only)
-- - CNN Business (no RSS)
-- - Reuters Tech (requires authentication)
-- - Variety (paywalled/limited RSS)
--
-- Consider adding these as email subscriptions:
-- INSERT INTO industry_feeds (name, feed_url, category, email_slug, accepts_email, is_active) VALUES
--   ('tipsheet.ai', 'email://tipsheet', 'ai', 'tipsheet', true, true)
-- ON CONFLICT (feed_url) DO NOTHING;

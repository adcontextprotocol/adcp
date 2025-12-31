-- Migration: 060_expand_industry_feeds.sql
-- Add more advertising and ad-tech industry RSS feeds

INSERT INTO industry_feeds (name, feed_url, category) VALUES
  -- Ad Tech focused
  ('ExchangeWire', 'https://www.exchangewire.com/feed/', 'ad-tech'),
  ('Ad Tech Daily', 'https://adtechdaily.com/feed/', 'ad-tech'),
  ('AdMonsters', 'https://www.admonsters.com/feed/', 'ad-tech'),
  ('Adweek Ad Tech', 'https://www.adweek.com/category/ad-tech/feed/', 'ad-tech'),
  ('PPC Land', 'https://ppc.land/feed/', 'ad-tech'),

  -- Marketing Technology
  ('MarTech', 'https://martech.org/feed/', 'martech'),
  ('Search Engine Land', 'https://searchengineland.com/feed', 'martech'),

  -- Industry associations and standards
  ('IAB', 'https://www.iab.com/feed/', 'industry'),

  -- Regional/International
  ('Campaign Asia', 'https://www.campaignasia.com/rss/rss.ashx', 'advertising'),

  -- Marketing strategy
  ('Marketing Week', 'https://www.marketingweek.com/feed/', 'marketing')
ON CONFLICT (feed_url) DO NOTHING;

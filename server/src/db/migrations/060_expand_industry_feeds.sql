-- Migration: 060_expand_industry_feeds.sql
-- Expand industry feed coverage across multiple advertising verticals

-- ============================================
-- RSS FEEDS (working feeds verified Dec 2025)
-- ============================================

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
  ('Marketing Week', 'https://www.marketingweek.com/feed/', 'marketing'),

  -- Adweek full coverage (main feed)
  ('Adweek', 'https://www.adweek.com/feed/', 'advertising'),

  -- CTV / Streaming / TV Advertising
  ('Adweek TV & Streaming', 'https://www.adweek.com/category/tv-streaming/feed/', 'ctv'),

  -- DOOH / Out of Home
  ('OOH Today', 'https://oohtoday.com/feed/', 'dooh'),
  ('Digital Signage Today', 'https://www.digitalsignagetoday.com/rss/', 'dooh'),

  -- Influencer / Creator Economy
  ('Net Influencer', 'https://netinfluencer.com/feed/', 'creator'),
  ('CreatorIQ', 'https://creatoriq.com/blog/rss.xml', 'creator'),
  ('Adweek Influencer Marketing', 'https://www.adweek.com/category/influencer-marketing/feed/', 'creator'),

  -- AI in Advertising
  ('Marketing AI Institute', 'https://www.marketingaiinstitute.com/blog/rss.xml', 'ai'),
  ('Adweek AI', 'https://www.adweek.com/category/artificial-intelligence/feed/', 'ai'),

  -- Sports / NIL
  ('Business of College Sports', 'https://businessofcollegesports.com/feed/', 'sports'),
  ('Sportico', 'https://www.sportico.com/feed/', 'sports')
ON CONFLICT (feed_url) DO NOTHING;


-- ============================================
-- EMAIL SUBSCRIPTION ENTRIES
-- For newsletters without RSS feeds
-- Subscribe at: feed-<slug>@updates.agenticadvertising.org
-- ============================================

INSERT INTO industry_feeds (name, feed_url, category, email_slug, accepts_email, is_active) VALUES
  -- Major publications without RSS
  ('Ad Age', 'email://adage', 'advertising', 'adage', true, true),
  ('The Drum', 'email://thedrum', 'advertising', 'thedrum', true, true),
  ('Campaign UK', 'email://campaign-uk', 'advertising', 'campaign-uk', true, true),
  ('eMarketer', 'email://emarketer', 'research', 'emarketer', true, true),

  -- Industry newsletters
  ('Marketecture', 'email://marketecture', 'ad-tech', 'marketecture', true, true),
  ('AdTechGod', 'email://adtechgod', 'ad-tech', 'adtechgod', true, true),

  -- CTV/Streaming newsletters
  ('TVRev', 'email://tvrev', 'ctv', 'tvrev', true, true),

  -- Morning newsletters
  ('Marketing Brew', 'email://marketing-brew', 'marketing', 'marketing-brew', true, true)
ON CONFLICT (feed_url) DO NOTHING;

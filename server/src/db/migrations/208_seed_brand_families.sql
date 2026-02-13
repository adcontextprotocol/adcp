-- Migration: 208_seed_brand_families.sql
-- Purpose: Expand brand registry with major brand families (houses + key sub-brands)
-- These represent the top advertising spenders organized by corporate family.

-- Remove regional Amazon variants (the enrichment pipeline consolidates these)
DELETE FROM discovered_brands WHERE domain IN (
  'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it'
);

-- CPG: Procter & Gamble family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('pg.com', 'Procter & Gamble', 'community', false),
  ('tide.com', 'Tide', 'community', false),
  ('gillette.com', 'Gillette', 'community', false),
  ('pampers.com', 'Pampers', 'community', false),
  ('oldspice.com', 'Old Spice', 'community', false),
  ('olay.com', 'Olay', 'community', false),
  ('charmin.com', 'Charmin', 'community', false),
  ('bounty.com', 'Bounty', 'community', false),
  ('crest.com', 'Crest', 'community', false),
  ('headandshoulders.com', 'Head & Shoulders', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- CPG: Unilever family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('unilever.com', 'Unilever', 'community', false),
  ('dove.com', 'Dove', 'community', false),
  ('axe.com', 'Axe', 'community', false),
  ('hellmanns.com', 'Hellmann''s', 'community', false),
  ('benandjerrys.com', 'Ben & Jerry''s', 'community', false),
  ('knorr.com', 'Knorr', 'community', false),
  ('degree.com', 'Degree', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- CPG: Nestle family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('nestle.com', 'Nestle', 'community', false),
  ('nespresso.com', 'Nespresso', 'community', false),
  ('purina.com', 'Purina', 'community', false),
  ('gerber.com', 'Gerber', 'community', false),
  ('haagen-dazs.com', 'Haagen-Dazs', 'community', false),
  ('stouffers.com', 'Stouffer''s', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- CPG: Coca-Cola Company family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('coca-colacompany.com', 'The Coca-Cola Company', 'community', false),
  ('fanta.com', 'Fanta', 'community', false),
  ('sprite.com', 'Sprite', 'community', false),
  ('minutemaid.com', 'Minute Maid', 'community', false),
  ('dasani.com', 'Dasani', 'community', false),
  ('smartwater.com', 'Smartwater', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- CPG: PepsiCo family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('pepsico.com', 'PepsiCo', 'community', false),
  ('doritos.com', 'Doritos', 'community', false),
  ('lays.com', 'Lay''s', 'community', false),
  ('gatorade.com', 'Gatorade', 'community', false),
  ('mountaindew.com', 'Mountain Dew', 'community', false),
  ('tropicana.com', 'Tropicana', 'community', false),
  ('quakeroats.com', 'Quaker Oats', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- CPG: Other major houses
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('mars.com', 'Mars', 'community', false),
  ('snickers.com', 'Snickers', 'community', false),
  ('mms.com', 'M&M''s', 'community', false),
  ('colgatepalmolive.com', 'Colgate-Palmolive', 'community', false),
  ('colgate.com', 'Colgate', 'community', false),
  ('kraftheinzcompany.com', 'Kraft Heinz', 'community', false),
  ('heinz.com', 'Heinz', 'community', false),
  ('kimberly-clark.com', 'Kimberly-Clark', 'community', false),
  ('huggies.com', 'Huggies', 'community', false),
  ('generalmills.com', 'General Mills', 'community', false),
  ('cheerios.com', 'Cheerios', 'community', false),
  ('kelloggs.com', 'Kellogg''s', 'community', false),
  ('reckitt.com', 'Reckitt', 'community', false),
  ('lysol.com', 'Lysol', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Auto: GM family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('gm.com', 'General Motors', 'community', false),
  ('chevrolet.com', 'Chevrolet', 'community', false),
  ('cadillac.com', 'Cadillac', 'community', false),
  ('buick.com', 'Buick', 'community', false),
  ('gmc.com', 'GMC', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Auto: Stellantis family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('stellantis.com', 'Stellantis', 'community', false),
  ('jeep.com', 'Jeep', 'community', false),
  ('dodge.com', 'Dodge', 'community', false),
  ('ramtrucks.com', 'Ram', 'community', false),
  ('chrysler.com', 'Chrysler', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Auto: VW Group family
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('volkswagen.com', 'Volkswagen', 'community', false),
  ('audi.com', 'Audi', 'community', false),
  ('porsche.com', 'Porsche', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Auto: Hyundai Motor Group
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('hyundai.com', 'Hyundai', 'community', false),
  ('kia.com', 'Kia', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Tech: Corporate houses
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('meta.com', 'Meta', 'community', false),
  ('whatsapp.com', 'WhatsApp', 'community', false),
  ('alphabet.com', 'Alphabet', 'community', false),
  ('about.google', 'Google (Corporate)', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Media: Corporate houses
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('nbcuniversal.com', 'NBCUniversal', 'community', false),
  ('comcastcorporation.com', 'Comcast', 'community', false),
  ('paramountglobal.com', 'Paramount Global', 'community', false),
  ('thewaltdisneycompany.com', 'The Walt Disney Company', 'community', false),
  ('foxcorporation.com', 'Fox Corporation', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Pharma: Major advertisers
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('pfizer.com', 'Pfizer', 'community', false),
  ('abbvie.com', 'AbbVie', 'community', false),
  ('merck.com', 'Merck', 'community', false),
  ('novartis.com', 'Novartis', 'community', false),
  ('bms.com', 'Bristol-Myers Squibb', 'community', false),
  ('gsk.com', 'GSK', 'community', false),
  ('jnj.com', 'Johnson & Johnson', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Financial: Houses (Chase/JPM, etc.)
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('jpmorganchase.com', 'JPMorgan Chase', 'community', false),
  ('berkshirehathaway.com', 'Berkshire Hathaway', 'community', false),
  ('goldmansachs.com', 'Goldman Sachs', 'community', false),
  ('morganstanley.com', 'Morgan Stanley', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Telecom: Houses
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('comcast.com', 'Comcast', 'community', false),
  ('dtelecom.com', 'Deutsche Telekom', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Retail: Additional major advertisers
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('samsclub.com', 'Sam''s Club', 'community', false),
  ('macys.com', 'Macy''s', 'community', false),
  ('nordstrom.com', 'Nordstrom', 'community', false),
  ('gap.com', 'Gap', 'community', false),
  ('oldnavy.com', 'Old Navy', 'community', false),
  ('sephora.com', 'Sephora', 'community', false),
  ('instacart.com', 'Instacart', 'community', false)
ON CONFLICT (domain) DO NOTHING;

-- Quick Service / Restaurants
INSERT INTO discovered_brands (domain, brand_name, source_type, has_brand_manifest)
VALUES
  ('wendys.com', 'Wendy''s', 'community', false),
  ('bk.com', 'Burger King', 'community', false),
  ('chipotle.com', 'Chipotle', 'community', false),
  ('starbucks.com', 'Starbucks', 'community', false),
  ('subway.com', 'Subway', 'community', false),
  ('dominos.com', 'Domino''s', 'community', false)
ON CONFLICT (domain) DO NOTHING;

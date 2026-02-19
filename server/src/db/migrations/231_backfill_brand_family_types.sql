-- Migration: 231_backfill_brand_family_types.sql
-- Purpose: Backfill keller_type and house_domain for brands seeded in 203 and 208.
-- These were inserted without hierarchy data; this migration sets it based on the
-- known brand family structure used in those seeds.

-- ============================================================
-- Top-level corporate houses (keller_type = 'master')
-- ============================================================
UPDATE discovered_brands SET keller_type = 'master' WHERE domain IN (
  -- CPG
  'pg.com', 'unilever.com', 'nestle.com', 'coca-colacompany.com', 'pepsico.com',
  'mars.com', 'colgatepalmolive.com', 'kraftheinzcompany.com', 'kimberly-clark.com',
  'generalmills.com', 'kelloggs.com', 'reckitt.com',
  -- Auto
  'gm.com', 'stellantis.com', 'volkswagen.com', 'hyundai.com',
  -- Tech / Media
  'meta.com', 'alphabet.com', 'nbcuniversal.com', 'comcastcorporation.com',
  'paramountglobal.com', 'thewaltdisneycompany.com', 'foxcorporation.com',
  'wbd.com',
  -- Financial
  'jpmorganchase.com', 'berkshirehathaway.com', 'goldmansachs.com', 'morganstanley.com',
  -- Telecom
  'comcast.com', 'dtelecom.com', 'verizon.com',
  -- Pharma
  'pfizer.com', 'abbvie.com', 'merck.com', 'novartis.com', 'bms.com', 'gsk.com', 'jnj.com',
  -- Retail with known sub-brands in registry
  'walmart.com', 'gap.com', 'amazon.com'
);

-- ============================================================
-- Independent brands (standalone advertisers, no tracked sub-brands)
-- ============================================================
UPDATE discovered_brands SET keller_type = 'independent' WHERE domain IN (
  'progressive.com', 'adobe.com', 'target.com', 'bestbuy.com', 'statefarm.com',
  'geico.com', 'allstate.com', 'ulta.com', 'mcdonalds.com', 'lilly.com',
  'samsung.com', 'walgreens.com', 'doordash.com', 'americanexpress.com',
  'homedepot.com', 'trulieve.com', 'goarmy.com', 'scopely.com', 'tiktok.com',
  'rbc.com', 'capitalone.com', 'dollargeneral.com', 'livenationentertainment.com',
  'discover.com', 'apple.com', 'microsoft.com', 'netflix.com', 'spotify.com',
  'starbucks.com', 'chipotle.com', 'wendys.com', 'bk.com', 'subway.com',
  'dominos.com', 'macys.com', 'nordstrom.com', 'sephora.com', 'instacart.com',
  'pfizer.com', 'lilly.com'
);

-- ============================================================
-- Sub-brands (keller_type = 'sub_brand') with house_domain
-- ============================================================

-- P&G sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'pg.com'
WHERE domain IN (
  'tide.com', 'gillette.com', 'pampers.com', 'oldspice.com', 'olay.com',
  'charmin.com', 'bounty.com', 'crest.com', 'headandshoulders.com', 'vicks.com'
);

-- Unilever sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'unilever.com'
WHERE domain IN (
  'dove.com', 'axe.com', 'hellmanns.com', 'benandjerrys.com', 'knorr.com', 'degree.com'
);

-- Nestle sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'nestle.com'
WHERE domain IN (
  'nespresso.com', 'purina.com', 'gerber.com', 'haagen-dazs.com', 'stouffers.com'
);

-- Coca-Cola sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'coca-colacompany.com'
WHERE domain IN (
  'fanta.com', 'sprite.com', 'minutemaid.com', 'dasani.com', 'smartwater.com'
);

-- PepsiCo sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'pepsico.com'
WHERE domain IN (
  'doritos.com', 'lays.com', 'gatorade.com', 'mountaindew.com', 'tropicana.com', 'quakeroats.com'
);

-- Mars sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'mars.com'
WHERE domain IN ('snickers.com', 'mms.com');

-- Colgate-Palmolive sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'colgatepalmolive.com'
WHERE domain IN ('colgate.com');

-- Kraft Heinz sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'kraftheinzcompany.com'
WHERE domain IN ('heinz.com');

-- Kimberly-Clark sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'kimberly-clark.com'
WHERE domain IN ('huggies.com');

-- General Mills sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'generalmills.com'
WHERE domain IN ('cheerios.com');

-- GM sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'gm.com'
WHERE domain IN ('chevrolet.com', 'cadillac.com', 'buick.com', 'gmc.com');

-- Stellantis sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'stellantis.com'
WHERE domain IN ('jeep.com', 'dodge.com', 'ramtrucks.com', 'chrysler.com');

-- VW Group sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'volkswagen.com'
WHERE domain IN ('audi.com', 'porsche.com');

-- Hyundai sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'hyundai.com'
WHERE domain IN ('kia.com');

-- Meta sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'meta.com'
WHERE domain IN ('whatsapp.com', 'facebook.com');

-- Alphabet sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'alphabet.com'
WHERE domain IN ('about.google', 'youtube.com', 'google.com');

-- Comcast sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'comcastcorporation.com'
WHERE domain IN ('nbcuniversal.com', 'xfinity.com', 'spectrum.com');

-- NBCUniversal sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'nbcuniversal.com'
WHERE domain IN ('peacocktv.com');

-- Paramount sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'paramountglobal.com'
WHERE domain IN ('paramountplus.com');

-- Walt Disney sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'thewaltdisneycompany.com'
WHERE domain IN ('disneyplus.com', 'go.com');

-- Warner Bros. Discovery sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'wbd.com'
WHERE domain IN ('discovery.com', 'max.com');

-- Walmart sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'walmart.com'
WHERE domain IN ('samsclub.com');

-- Gap sub-brands
UPDATE discovered_brands SET keller_type = 'sub_brand', house_domain = 'gap.com'
WHERE domain IN ('oldnavy.com');

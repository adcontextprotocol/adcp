-- Brand domain aliases: supports multiple alternate domains per brand
-- e.g. omc.com, omnicom.com → omnicomgroup.com
-- e.g. nbcuni.com → nbcuniversal.com

CREATE TABLE IF NOT EXISTS brand_domain_aliases (
  alias_domain TEXT PRIMARY KEY,         -- the alternate domain (e.g. omc.com)
  brand_domain TEXT NOT NULL,            -- the canonical brand domain in discovered_brands
  source TEXT NOT NULL DEFAULT 'admin',  -- admin, classifier, enrichment, migrated
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_domain_aliases_brand ON brand_domain_aliases(brand_domain);

-- Migrate existing canonical_domain data
INSERT INTO brand_domain_aliases (alias_domain, brand_domain, source)
SELECT canonical_domain, domain, 'migrated'
FROM discovered_brands
WHERE canonical_domain IS NOT NULL
  AND canonical_domain != ''
  AND canonical_domain != domain
ON CONFLICT (alias_domain) DO NOTHING;

-- Migration: 229_member_primary_brand.sql
-- Purpose: Make brand registry the source of truth for member company identity.
-- Adds primary_brand_domain to link member profiles to their brand in the registry,
-- migrates existing logo/color data into hosted_brands, then drops the redundant columns.

-- Step 1: Add the brand registry link column
ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS primary_brand_domain TEXT;

CREATE INDEX IF NOT EXISTS idx_member_profiles_primary_brand
  ON member_profiles(primary_brand_domain);

-- Step 2: Migrate existing logo/color data to hosted_brands.
-- Derives domain from contact_website (stripping protocol/www/path) or falls back to slug.agenticadvertising.org.
-- ON CONFLICT DO NOTHING to avoid clobbering any existing hosted_brand entry for the same domain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'member_profiles' AND column_name = 'logo_url') THEN
    WITH member_domains AS (
      SELECT
        id,
        workos_organization_id,
        display_name,
        logo_url,
        brand_color,
        COALESCE(
          NULLIF(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(contact_website, ''), '^https?://(www\.)?', ''), '[/?#].*$', ''), ''),
          slug || '.agenticadvertising.org'
        ) AS brand_domain
      FROM member_profiles
      WHERE logo_url IS NOT NULL OR brand_color IS NOT NULL
    ),
    inserted AS (
      INSERT INTO hosted_brands (workos_organization_id, brand_domain, brand_json, is_public)
      SELECT
        workos_organization_id,
        brand_domain,
        jsonb_build_object(
          'house', jsonb_build_object('domain', brand_domain, 'name', display_name),
          'brands', jsonb_build_array(
            jsonb_build_object(
              'id', REGEXP_REPLACE(LOWER(display_name), '[^a-z0-9]+', '_', 'g'),
              'names', jsonb_build_array(jsonb_build_object('en', display_name)),
              'logos', CASE WHEN logo_url IS NOT NULL
                         THEN jsonb_build_array(jsonb_build_object('url', logo_url))
                         ELSE '[]'::jsonb END,
              'colors', CASE WHEN brand_color IS NOT NULL
                          THEN jsonb_build_object('primary', brand_color)
                          ELSE '{}'::jsonb END
            )
          )
        ),
        true
      FROM member_domains
      ON CONFLICT (brand_domain) DO NOTHING
      RETURNING brand_domain, workos_organization_id
    )
    UPDATE member_profiles mp
    SET primary_brand_domain = ins.brand_domain
    FROM inserted ins
    WHERE mp.workos_organization_id = ins.workos_organization_id;
  END IF;
END $$;

-- Step 3: Drop the event_sponsors view which references mp.logo_url, then drop the columns.
-- The view is recreated below using es.logo_url (event sponsor's own logo) as the display logo.
DROP VIEW IF EXISTS event_sponsors;

ALTER TABLE member_profiles
  DROP COLUMN IF EXISTS logo_url,
  DROP COLUMN IF EXISTS logo_light_url,
  DROP COLUMN IF EXISTS logo_dark_url,
  DROP COLUMN IF EXISTS brand_color;

-- Step 4: Recreate event_sponsors view without the removed member_profiles.logo_url reference.
-- display_logo_url now uses the event sponsorship's own logo field.
CREATE OR REPLACE VIEW event_sponsors AS
  SELECT
    es.event_id,
    es.tier_id,
    es.tier_name,
    es.display_order,
    es.logo_url,
    o.workos_organization_id AS organization_id,
    o.name AS organization_name,
    es.logo_url AS display_logo_url,
    mp.contact_website AS organization_website
  FROM event_sponsorships es
  JOIN organizations o ON o.workos_organization_id = es.organization_id
  LEFT JOIN member_profiles mp ON mp.workos_organization_id = o.workos_organization_id
  WHERE es.payment_status = 'paid' AND es.show_logo = true
  ORDER BY es.display_order, es.paid_at;

-- Backfill domain rows for fresh orphan prospect orgs.
--
-- Migration 481 handled legacy rows by deriving a non-verified domain from
-- prospect_contact_email. The orphan-org audit now caught a newer inbound
-- path where a prospect org was created from triage context without carrying
-- the triaged domain into organizations.email_domain or organization_domains.
--
-- Strategy:
--   1) Prefer a business prospect_contact_email domain when present.
--   2) Otherwise use a matching prospect_triage_log create decision: same
--      source, same company name, close in time.
--   3) Exclude free-email/shared-platform domains and any domain already
--      owned by another org.
--   4) Write an unverified primary organization_domains row and sync
--      organizations.email_domain so claim flows can find the prospect.
--
-- Important: contact emails and triage logs are not DNS proof-of-control.
-- These rows intentionally remain verified=false; paying auto-link stays
-- blocked until an admin/WorkOS path verifies the domain.

WITH inferred AS (
  SELECT
    o.workos_organization_id,
    LOWER(split_part(o.prospect_contact_email, '@', 2)) AS domain,
    0 AS rank,
    0::double precision AS age_delta
  FROM organizations o
  LEFT JOIN organization_domains od
    ON od.workos_organization_id = o.workos_organization_id
  WHERE o.is_personal = FALSE
    AND (o.email_domain IS NULL OR o.email_domain = '')
    AND od.workos_organization_id IS NULL
    AND NULLIF(TRIM(o.prospect_contact_email), '') IS NOT NULL
    AND position('@' IN o.prospect_contact_email) > 0

  UNION ALL

  SELECT
    o.workos_organization_id,
    LOWER(TRIM(ptl.domain)) AS domain,
    1 AS rank,
    ABS(EXTRACT(EPOCH FROM (ptl.created_at - o.created_at))) AS age_delta
  FROM organizations o
  LEFT JOIN organization_domains od
    ON od.workos_organization_id = o.workos_organization_id
  JOIN prospect_triage_log ptl
    ON LOWER(TRIM(ptl.company_name)) = LOWER(TRIM(o.name))
   AND ptl.action = 'create'
   AND ptl.source = o.prospect_source
   AND ptl.created_at BETWEEN o.created_at - INTERVAL '7 days'
                          AND o.created_at + INTERVAL '7 days'
  WHERE o.is_personal = FALSE
    AND (o.email_domain IS NULL OR o.email_domain = '')
    AND od.workos_organization_id IS NULL
    AND o.prospect_source IN ('inbound', 'slack')
    AND NULLIF(TRIM(ptl.domain), '') IS NOT NULL
),
valid_inferred AS (
  SELECT workos_organization_id, domain, rank, age_delta
  FROM inferred
  WHERE domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    AND domain NOT IN (
      -- Free-email providers
      'gmail.com','googlemail.com',
      'outlook.com','hotmail.com','live.com','msn.com',
      'yahoo.com','yahoo.co.uk','ymail.com','rocketmail.com',
      'aol.com','aim.com',
      'icloud.com','me.com','mac.com',
      'proton.me','protonmail.com','pm.me',
      'zoho.com','fastmail.com','gmx.com','gmx.net','mail.com',
      'yandex.com','yandex.ru','qq.com','163.com','126.com',
      'duck.com','hey.com','tutanota.com','tutanota.de',
      'uol.com.ar','uol.com.br','uol.com.co','uol.com.mx','uol.com.ve',
      'uole.com','uole.com.ve','uolmail.com',
      -- Shared platform / public-suffix domains
      'vercel.app','vercel.com','netlify.app','netlify.com',
      'fly.dev','fly.io','render.com','pages.dev','workers.dev',
      'web.app','firebaseapp.com','cloudfront.net','amplifyapp.com',
      'replit.app','replit.dev','repl.co','glitch.me','azurewebsites.net',
      'herokuapp.com',
      'github.io','gitlab.io','bitbucket.io','readthedocs.io',
      'medium.com','substack.com','wordpress.com','blogspot.com',
      'tumblr.com','wixsite.com','squarespace.com',
      'linkedin.com','twitter.com','x.com','facebook.com','fb.com',
      'instagram.com','youtube.com','tiktok.com','reddit.com',
      'pinterest.com','discord.com','snapchat.com','threads.net',
      'whatsapp.com','wa.me',
      'co.uk','co.jp','com.au','com.br','co.in','co.nz','co.za',
      'org.uk','ac.uk','gov.uk','me.uk','ne.jp','or.jp'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        '.hubspotusercontent.com',
        '.hubspotusercontent-na1.net','.hubspotusercontent-na2.net',
        '.hubspotusercontent-eu1.net','.hubspotusercontent-ap1.net',
        '.amazonaws.com',
        '.googleusercontent.com',
        '.atlassian.net',
        '.zendesk.com','.freshdesk.com',
        '.salesforce.com','.force.com','.lightning.force.com',
        '.shopify.com','.myshopify.com',
        '.typeform.com','.airtable.com','.notion.site',
        '.canva.site','.canva.com',
        '.mailchimp.com','.intercom.io'
      ]) AS shared_suffix(suffix)
      WHERE domain LIKE '%' || shared_suffix.suffix
    )
),
ranked AS (
  SELECT DISTINCT ON (workos_organization_id)
    workos_organization_id,
    domain
  FROM valid_inferred
  ORDER BY workos_organization_id, rank ASC, age_delta ASC, domain ASC
),
candidate AS (
  SELECT workos_organization_id, domain
  FROM ranked
  WHERE NOT EXISTS (
      SELECT 1 FROM organization_domains od2
      WHERE od2.domain = ranked.domain
        AND od2.workos_organization_id != ranked.workos_organization_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM organizations o2
      WHERE LOWER(o2.email_domain) = ranked.domain
        AND o2.workos_organization_id != ranked.workos_organization_id
    )
),
inserted AS (
  INSERT INTO organization_domains
    (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
  SELECT
    workos_organization_id,
    domain,
    TRUE,
    FALSE,
    'backfill_prospect_contact',
    NOW(),
    NOW()
  FROM candidate
  ON CONFLICT (domain) DO NOTHING
  RETURNING workos_organization_id, domain
)
UPDATE organizations o
SET email_domain = inserted.domain, updated_at = NOW()
FROM inserted
WHERE o.workos_organization_id = inserted.workos_organization_id
  AND o.is_personal = FALSE
  AND (o.email_domain IS NULL OR o.email_domain = '');

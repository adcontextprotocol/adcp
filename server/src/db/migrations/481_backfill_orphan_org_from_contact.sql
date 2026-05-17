-- Backfill organizations.email_domain + organization_domains for orphan prospect
-- orgs that have NEITHER column populated.
--
-- Why: Migration 468 fills email_domain from organization_domains, but legacy
-- prospect orgs created before the at-INSERT hardening (PR #4132, May 2026)
-- never wrote either column — the WorkOS organization.updated webhook was
-- supposed to backfill both and didn't always fire. Real-world driver:
-- org_01KDRZJAK62QV0CW53EEQJWWC2 ("Spotify", created 2025-12-30) has
-- prospect_contact_email='chelseag@spotify.com' but neither email_domain nor
-- an organization_domains row, so findPayingOrgForDomain,
-- findClaimableProspectOrgForDomain, and resolveOrgByDomain all miss it.
-- Result: every later @spotify.com signup looks "new" to triage and posts a
-- duplicate prospect alert.
--
-- Strategy: derive the missing domain from prospect_contact_email. Only fills
-- where:
--   1) Org is non-personal, email_domain is NULL/empty, no organization_domains row
--   2) prospect_contact_email is well-formed and not a free-email provider
--   3) Domain looks like a valid hostname (apex regex)
--   4) Domain is not already owned by another org in organization_domains
--
-- Migration 468 then runs again as a no-op for newly populated rows (its
-- COALESCE already filled email_domain via the linkDomain trigger in
-- step 2 below). Run order matters: insert organization_domains first
-- with is_primary=true, which fires the email_domain update via
-- linkDomain semantics in the new ensureOrganizationExists path going
-- forward. Here we do both writes explicitly in one migration.

WITH inferred AS (
  SELECT
    o.workos_organization_id,
    LOWER(split_part(o.prospect_contact_email, '@', 2)) AS domain
  FROM organizations o
  LEFT JOIN organization_domains od
    ON od.workos_organization_id = o.workos_organization_id
  WHERE o.is_personal = FALSE
    AND (o.email_domain IS NULL OR o.email_domain = '')
    AND od.workos_organization_id IS NULL
    AND o.prospect_contact_email IS NOT NULL
    AND position('@' IN o.prospect_contact_email) > 0
  GROUP BY o.workos_organization_id, o.prospect_contact_email
),
candidate AS (
  SELECT workos_organization_id, domain
  FROM inferred
  WHERE domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    -- Exclude free-email providers AND shared-platform domains. Mirrors
    -- FREE_EMAIL_PROVIDER_DOMAINS + the most relevant entries of
    -- SHARED_PLATFORM_DOMAINS in server/src/services/identifier-normalization.ts.
    -- A contact at gmail.com / substack.com / a Vercel subdomain says nothing
    -- about the prospect's brand domain, and planting one in
    -- organization_domains would block the legitimate platform tenant.
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
      -- Shared platform / content host domains (apex matches only — subdomain
      -- variants like brand.vercel.app are blocked by the UNIQUE(domain)
      -- constraint via a legit owner if one ever claims them, and the
      -- backfill writes verified=false so they can't trigger auto-link).
      'vercel.app','vercel.com','netlify.app','netlify.com',
      'fly.dev','fly.io','render.com','herokuapp.com',
      'github.io','gitlab.io','readthedocs.io',
      'medium.com','substack.com','wordpress.com','blogspot.com',
      'tumblr.com','wixsite.com','squarespace.com',
      'linkedin.com','twitter.com','x.com','facebook.com','fb.com',
      'instagram.com','youtube.com','tiktok.com','reddit.com',
      'pinterest.com','discord.com','snapchat.com','threads.net',
      'whatsapp.com','wa.me'
    )
    -- Don't steal a domain another org already owns
    AND NOT EXISTS (
      SELECT 1 FROM organization_domains od2
      WHERE od2.domain = inferred.domain
        AND od2.workos_organization_id != inferred.workos_organization_id
    )
),
inserted AS (
  INSERT INTO organization_domains
    (workos_organization_id, domain, is_primary, verified, source, created_at, updated_at)
  SELECT
    workos_organization_id,
    domain,
    TRUE,
    -- Not DNS-verified — derived from prospect_contact_email. Auto-link paths
    -- (findPayingOrgForDomain) gate on verified=true, so this row alone
    -- won't trigger auto-membership; it only makes the org visible to
    -- findClaimableProspectOrgForDomain and resolveOrgByDomain.
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

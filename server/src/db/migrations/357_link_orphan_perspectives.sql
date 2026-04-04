-- Backfill author ownership for perspectives missing user linkage.
-- Without author_user_id + content_authors, perspectives don't appear
-- in the author's "My Content" view.

-- 1. Brian O'Kelley — agentic-advertising-is-for-allocation
WITH brian AS (
  SELECT workos_user_id
  FROM users
  WHERE lower(email) = 'brian@agenticadvertising.org'
  LIMIT 1
)
UPDATE perspectives p
SET author_user_id = u.workos_user_id,
    proposer_user_id = COALESCE(p.proposer_user_id, u.workos_user_id)
FROM brian u
WHERE p.slug = 'agentic-advertising-is-for-allocation'
  AND (p.author_user_id IS DISTINCT FROM u.workos_user_id OR p.proposer_user_id IS NULL);

INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT p.id, u.workos_user_id, 'Brian O''Kelley', p.author_title, 0
FROM perspectives p
JOIN users u ON lower(u.email) = 'brian@agenticadvertising.org'
WHERE p.slug = 'agentic-advertising-is-for-allocation'
ON CONFLICT (perspective_id, user_id) DO NOTHING;

-- 2. Benjamin Masse — signals-planning-sleeper-use-case
WITH ben AS (
  SELECT om.workos_user_id
  FROM member_profiles mp
  JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
  WHERE mp.slug = 'ben-masse'
  LIMIT 1
)
UPDATE perspectives p
SET author_user_id = u.workos_user_id,
    proposer_user_id = COALESCE(p.proposer_user_id, u.workos_user_id)
FROM ben u
WHERE p.slug = 'signals-planning-sleeper-use-case'
  AND (p.author_user_id IS DISTINCT FROM u.workos_user_id OR p.proposer_user_id IS NULL);

INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT p.id, om.workos_user_id, 'Benjamin Masse', p.author_title, 0
FROM perspectives p
JOIN member_profiles mp ON mp.slug = 'ben-masse'
JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
WHERE p.slug = 'signals-planning-sleeper-use-case'
ON CONFLICT (perspective_id, user_id) DO NOTHING;

-- 3. Randall Rothenberg — three-superpowers-agentic-advertising (external link)
--    and building-future-of-marketing (co-authored with Matt Egol)
--    Use member profile to resolve user ID.
WITH randall AS (
  SELECT om.workos_user_id
  FROM member_profiles mp
  JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
  WHERE mp.slug = 'randall-rothenberg'
  LIMIT 1
)
UPDATE perspectives p
SET author_user_id = u.workos_user_id,
    proposer_user_id = COALESCE(p.proposer_user_id, u.workos_user_id)
FROM randall u
WHERE p.slug IN ('three-superpowers-agentic-advertising', 'building-future-of-marketing')
  AND (p.author_user_id IS DISTINCT FROM u.workos_user_id OR p.proposer_user_id IS NULL);

INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT p.id, om.workos_user_id, 'Randall Rothenberg', NULL, 0
FROM perspectives p
JOIN member_profiles mp ON mp.slug = 'randall-rothenberg'
JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
WHERE p.slug IN ('three-superpowers-agentic-advertising', 'building-future-of-marketing')
ON CONFLICT (perspective_id, user_id) DO NOTHING;

-- 4. Matt Egol — building-future-of-marketing (co-author with Randall)
INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT p.id, om.workos_user_id, 'Matthew Egol', NULL, 1
FROM perspectives p
JOIN member_profiles mp ON mp.slug = 'matt-egol'
JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
WHERE p.slug = 'building-future-of-marketing'
ON CONFLICT (perspective_id, user_id) DO NOTHING;

-- Note: rajeev-goel-agentic-advertising, agentic-protocol-landscape, and
-- launch-announcement are not linked because those authors either don't have
-- user accounts or are editorial/system content with no named author.

-- Backfill authored perspective ownership for the adagents vs ads.txt article
-- so public/profile and engagement queries can associate it with the user.

WITH target_user AS (
  SELECT workos_user_id
  FROM users
  WHERE lower(email) = 'brian@agenticadvertising.org'
  LIMIT 1
)
UPDATE perspectives p
SET author_user_id = tu.workos_user_id,
    proposer_user_id = COALESCE(p.proposer_user_id, tu.workos_user_id)
FROM target_user tu
WHERE p.slug = 'adagents-json-vs-ads-txt'
  AND (
    p.author_user_id IS DISTINCT FROM tu.workos_user_id
    OR p.proposer_user_id IS NULL
  );

INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT
  p.id,
  u.workos_user_id,
  COALESCE(p.author_name, 'Brian O''Kelley'),
  p.author_title,
  0
FROM perspectives p
JOIN users u ON lower(u.email) = 'brian@agenticadvertising.org'
WHERE p.slug = 'adagents-json-vs-ads-txt'
ON CONFLICT (perspective_id, user_id) DO NOTHING;

-- Enforce the invariant that an organization has at most one
-- organization_domains.is_primary=true row.
--
-- The original partial index was non-unique, so a WorkOS full-domain sync
-- could insert a newly first-listed domain as primary while preserving the
-- existing canonical primary. Repair any existing duplicates before replacing
-- the index with a unique partial index.

LOCK TABLE organization_domains IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    od.id,
    od.workos_organization_id,
    od.domain,
    ROW_NUMBER() OVER (
      PARTITION BY od.workos_organization_id
      ORDER BY
        (o.email_domain IS NOT NULL AND LOWER(od.domain) = LOWER(o.email_domain)) DESC,
        od.verified DESC,
        CASE od.source
          WHEN 'workos' THEN 0
          WHEN 'email_verification' THEN 1
          WHEN 'manual' THEN 2
          ELSE 3
        END,
        od.created_at ASC,
        od.id ASC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY od.workos_organization_id) AS primary_count
  FROM organization_domains od
  LEFT JOIN organizations o
    ON o.workos_organization_id = od.workos_organization_id
  WHERE od.is_primary = true
),
chosen AS (
  SELECT workos_organization_id, domain
  FROM ranked
  WHERE rn = 1 AND primary_count > 1
)
UPDATE organizations o
SET email_domain = chosen.domain,
    updated_at = NOW()
FROM chosen
WHERE o.workos_organization_id = chosen.workos_organization_id
  AND o.is_personal = false;

WITH ranked AS (
  SELECT
    od.id,
    ROW_NUMBER() OVER (
      PARTITION BY od.workos_organization_id
      ORDER BY
        (o.email_domain IS NOT NULL AND LOWER(od.domain) = LOWER(o.email_domain)) DESC,
        od.verified DESC,
        CASE od.source
          WHEN 'workos' THEN 0
          WHEN 'email_verification' THEN 1
          WHEN 'manual' THEN 2
          ELSE 3
        END,
        od.created_at ASC,
        od.id ASC
    ) AS rn
  FROM organization_domains od
  LEFT JOIN organizations o
    ON o.workos_organization_id = od.workos_organization_id
  WHERE od.is_primary = true
)
UPDATE organization_domains od
SET is_primary = false,
    updated_at = NOW()
FROM ranked
WHERE od.id = ranked.id
  AND ranked.rn > 1;

DROP INDEX IF EXISTS idx_organization_domains_primary;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_domains_primary
  ON organization_domains(workos_organization_id)
  WHERE is_primary = true;

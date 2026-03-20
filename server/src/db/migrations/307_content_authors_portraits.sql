-- Update content_with_authors view to include portrait IDs for each author
DROP VIEW IF EXISTS content_with_authors;
CREATE VIEW content_with_authors AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'user_id', ca.user_id,
        'display_name', ca.display_name,
        'display_title', ca.display_title,
        'display_order', ca.display_order,
        'portrait_id', mp.portrait_id::text
      ) ORDER BY ca.display_order
    )
    FROM content_authors ca
    LEFT JOIN organization_memberships om ON om.workos_user_id = ca.user_id
    LEFT JOIN member_profiles mp ON mp.workos_organization_id = om.workos_organization_id
      AND mp.portrait_id IS NOT NULL
    WHERE ca.perspective_id = p.id),
    '[]'::json
  ) AS authors_json
FROM perspectives p;

COMMENT ON VIEW content_with_authors IS 'Perspectives with aggregated authors including portrait IDs';

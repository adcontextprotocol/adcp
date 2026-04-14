-- Speed up admin accounts page queries that aggregate community points per org.
-- The community points join needs (workos_user_id → points) and membership
-- needs (workos_user_id → workos_organization_id). A covering index on
-- memberships lets the aggregation subquery avoid hitting the heap.

-- Covering index: org_id lookups that also need user_id (avoids heap fetch)
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_org
  ON organization_memberships(workos_user_id, workos_organization_id);

-- Covering index on community_points for SUM(points) by user
CREATE INDEX IF NOT EXISTS idx_community_points_user_points
  ON community_points(workos_user_id, points);

-- discovered_brands domain lookup (used in hierarchy join)
-- Adding house_domain + other fields as included columns avoids a heap
-- fetch for the common lookup pattern on the admin accounts page.
CREATE INDEX IF NOT EXISTS idx_discovered_brands_domain_house
  ON discovered_brands(domain) INCLUDE (house_domain, brand_name, keller_type, source_type);

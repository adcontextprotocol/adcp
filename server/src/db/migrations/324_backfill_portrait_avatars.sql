-- Backfill community avatar_url from approved portraits for members who don't have one set
UPDATE users
SET avatar_url = '/api/portraits/' || mp.portrait_id::text || '.png'
FROM organization_memberships om
JOIN member_profiles mp ON mp.workos_organization_id = om.workos_organization_id
JOIN member_portraits p ON p.id = mp.portrait_id
WHERE users.workos_user_id = om.workos_user_id
  AND mp.portrait_id IS NOT NULL
  AND p.status = 'approved'
  AND (users.avatar_url IS NULL OR users.avatar_url = '');

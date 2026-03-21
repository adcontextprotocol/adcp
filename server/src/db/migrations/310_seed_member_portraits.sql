-- Seed founding team portraits from existing static files.
-- BYTEA backfill happens when the generation service loads images from disk.
-- For now, image_url points to the static path and the serving endpoint
-- redirects to it when portrait_data is NULL.

INSERT INTO member_portraits (member_profile_id, image_url, palette, status, approved_at)
SELECT mp.id,
       '/images/cast/' || CASE mp.slug
         WHEN 'brian-okelley' THEN 'brian-okelley.png'
         WHEN 'randall-rothenberg' THEN 'randall-rothenberg.png'
         WHEN 'matt-egol' THEN 'matt-egol.png'
         WHEN 'ben-masse' THEN 'ben-masse.png'
       END,
       'amber', 'approved', NOW()
FROM member_profiles mp
WHERE mp.slug IN ('brian-okelley', 'randall-rothenberg', 'matt-egol', 'ben-masse')
  AND NOT EXISTS (
    SELECT 1 FROM member_portraits p WHERE p.member_profile_id = mp.id
  );

-- Point member_profiles.portrait_id at the seeded rows
UPDATE member_profiles mp
SET portrait_id = p.id
FROM member_portraits p
WHERE p.member_profile_id = mp.id
  AND p.status = 'approved'
  AND mp.portrait_id IS NULL;
